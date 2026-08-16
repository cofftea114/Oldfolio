import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  Backlink,
  IndexRebuildResult,
  MarkdownMetadata,
  SearchResult,
  VaultFileSnapshot,
} from './types.js';

interface PreparedDocument {
  snapshot: VaultFileSnapshot;
  metadata: MarkdownMetadata;
  resolvedLinks: Array<{
    targetPath: string;
    raw: string;
    kind: 'wikilink' | 'markdown';
    anchor?: string;
    label?: string;
  }>;
}

type SqlRow = Record<string, unknown>;

export class VaultIndex {
  private database: DatabaseSync | undefined;

  constructor(private readonly databasePath: string) {}

  private async open(): Promise<DatabaseSync> {
    if (this.database) return this.database;
    await mkdir(path.dirname(this.databasePath), { recursive: true });
    const database = new DatabaseSync(this.databasePath);
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database = database;
    return database;
  }

  async rebuild(documents: PreparedDocument[]): Promise<IndexRebuildResult> {
    const database = await this.open();
    database.exec(`
      DROP TABLE IF EXISTS documents_next;
      DROP TABLE IF EXISTS links_next;
      DROP TABLE IF EXISTS headings_next;
      DROP TABLE IF EXISTS tags_next;
      DROP TABLE IF EXISTS documents_fts_next;
      CREATE TABLE documents_next (
        path TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL
      ) STRICT;
      CREATE TABLE links_next (
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        raw TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('wikilink', 'markdown')),
        anchor TEXT,
        label TEXT
      ) STRICT;
      CREATE TABLE headings_next (
        document_path TEXT NOT NULL,
        level INTEGER NOT NULL,
        text TEXT NOT NULL,
        line INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE tags_next (
        document_path TEXT NOT NULL,
        tag TEXT NOT NULL
      ) STRICT;
      CREATE VIRTUAL TABLE documents_fts_next USING fts5(
        path UNINDEXED,
        title,
        body,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

    const insertDocument = database.prepare(
      'INSERT INTO documents_next(path, revision, title, body) VALUES (?, ?, ?, ?)',
    );
    const insertFts = database.prepare(
      'INSERT INTO documents_fts_next(path, title, body) VALUES (?, ?, ?)',
    );
    const insertLink = database.prepare(
      'INSERT INTO links_next(source_path, target_path, raw, kind, anchor, label) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertHeading = database.prepare(
      'INSERT INTO headings_next(document_path, level, text, line) VALUES (?, ?, ?, ?)',
    );
    const insertTag = database.prepare('INSERT INTO tags_next(document_path, tag) VALUES (?, ?)');

    database.exec('BEGIN IMMEDIATE');
    try {
      for (const document of documents) {
        const { snapshot, metadata } = document;
        const title = metadata.title ?? path.posix.basename(snapshot.path, '.md');
        insertDocument.run(snapshot.path, snapshot.revision, title, snapshot.text);
        insertFts.run(snapshot.path, title, snapshot.text);
        for (const link of document.resolvedLinks) {
          insertLink.run(
            snapshot.path,
            link.targetPath,
            link.raw,
            link.kind,
            link.anchor ?? null,
            link.label ?? null,
          );
        }
        for (const heading of metadata.headings) {
          insertHeading.run(snapshot.path, heading.level, heading.text, heading.line);
        }
        for (const tag of metadata.tags) insertTag.run(snapshot.path, tag);
      }

      database.exec(`
        DROP TABLE IF EXISTS documents;
        DROP TABLE IF EXISTS links;
        DROP TABLE IF EXISTS headings;
        DROP TABLE IF EXISTS tags;
        DROP TABLE IF EXISTS documents_fts;
        ALTER TABLE documents_next RENAME TO documents;
        ALTER TABLE links_next RENAME TO links;
        ALTER TABLE headings_next RENAME TO headings;
        ALTER TABLE tags_next RENAME TO tags;
        ALTER TABLE documents_fts_next RENAME TO documents_fts;
        CREATE INDEX links_target_idx ON links(target_path);
        CREATE INDEX tags_tag_idx ON tags(tag);
        COMMIT;
      `);
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    return {
      documents: documents.length,
      links: documents.reduce((sum, document) => sum + document.resolvedLinks.length, 0),
      tags: documents.reduce((sum, document) => sum + document.metadata.tags.length, 0),
      headings: documents.reduce((sum, document) => sum + document.metadata.headings.length, 0),
    };
  }

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const database = await this.open();
    const normalized = query.trim();
    if (!normalized) return [];
    const hasIndex = database
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='documents'")
      .get() as SqlRow | undefined;
    if (!hasIndex) return [];

    const terms = normalized.split(/\s+/u).filter(Boolean);
    const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
    try {
      const rows = database
        .prepare(
          `
          SELECT d.path, d.revision, d.title, bm25(documents_fts) AS score,
                 snippet(documents_fts, 2, '<mark>', '</mark>', '…', 20) AS excerpt
          FROM documents_fts
          JOIN documents d ON d.path = documents_fts.path
          WHERE documents_fts MATCH ?
          ORDER BY score, d.path
          LIMIT ?
        `,
        )
        .all(expression, limit) as SqlRow[];
      if (rows.length > 0) return rows.map(toSearchResult);
    } catch {
      // Fall through to literal substring search for malformed FTS syntax.
    }
    // unicode61 does not segment every CJK phrase and FTS has no tokens shorter
    // than its tokenizer accepts. Literal fallback keeps Chinese search useful.
    const pattern = `%${normalized.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const rows = database
      .prepare(
        `
        SELECT path, revision, title, 0.0 AS score,
               substr(body, 1, 240) AS excerpt
        FROM documents
        WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
        ORDER BY path
        LIMIT ?
      `,
      )
      .all(pattern, pattern, limit) as SqlRow[];
    return rows.map(toSearchResult);
  }

  async backlinks(targetPath: string): Promise<Backlink[]> {
    const database = await this.open();
    const hasIndex = database
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='links'")
      .get();
    if (!hasIndex) return [];
    const rows = database
      .prepare(
        `
        SELECT source_path, target_path, raw, kind, anchor, label
        FROM links WHERE target_path = ? ORDER BY source_path, raw
      `,
      )
      .all(targetPath) as SqlRow[];
    return rows.map((row) => ({
      sourcePath: stringColumn(row, 'source_path'),
      targetPath: stringColumn(row, 'target_path'),
      raw: stringColumn(row, 'raw'),
      kind: row.kind === 'markdown' ? 'markdown' : 'wikilink',
      ...(typeof row.anchor === 'string' ? { anchor: row.anchor } : {}),
      ...(typeof row.label === 'string' ? { label: row.label } : {}),
    }));
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }
}

function toSearchResult(row: SqlRow): SearchResult {
  return {
    path: stringColumn(row, 'path'),
    revision: stringColumn(row, 'revision'),
    title: stringColumn(row, 'title'),
    score: typeof row.score === 'number' ? row.score : 0,
    excerpt: typeof row.excerpt === 'string' ? row.excerpt : '',
  };
}

function stringColumn(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new TypeError(`Expected SQLite column ${column} to be text`);
  return value;
}

export type { PreparedDocument };
