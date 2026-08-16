import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open as openFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { DocumentRevision, WikiChangeSet, WikiFileOperation } from '@oldfolio/domain';

import {
  VaultConflictError,
  VaultHistoryError,
  VaultNotFoundError,
  VaultSymlinkError,
} from './errors.js';
import type { HistoryFileState, VaultHistoryRecord } from './history.js';
import { VaultIndex, type PreparedDocument } from './index-store.js';
import { extractMarkdownMetadata, resolveMarkdownTarget } from './markdown.js';
import { normalizeVaultPath, VaultPathResolver } from './path-safety.js';
import type {
  AppliedChangeSet,
  Backlink,
  IndexRebuildResult,
  SearchResult,
  UndoResult,
  VaultFileSnapshot,
  VaultRepositoryOptions,
} from './types.js';

const LAYOUT = [
  'notes',
  'assets',
  'bundles/personal/raw',
  'bundles/personal/wiki',
  'bundles/creators',
  'bundles/synthesis/wiki',
  '.oldfolio/schema',
  '.oldfolio/config',
  '.oldfolio/history',
  '.oldfolio/cache',
] as const;

const INITIAL_DOCUMENTS = {
  'bundles/personal/index.md': '---\nokf_version: "0.2"\n---\n\n# Personal knowledge\n',
  'bundles/personal/log.md': '# Change log\n',
  'bundles/synthesis/index.md': '---\nokf_version: "0.2"\n---\n\n# Synthesis\n',
  'bundles/synthesis/log.md': '# Change log\n',
} as const;

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function operationPath(operation: WikiFileOperation): string {
  return operation.kind === 'move' ? operation.fromPath : operation.path;
}

function revisionHash(revision: DocumentRevision): string {
  if (revision.revisionId !== revision.contentHash) {
    throw new VaultHistoryError(
      `Unsupported revision identity for ${revision.path}: vault revisions are SHA-256 content hashes`,
    );
  }
  return revision.contentHash;
}

export class VaultRepository {
  readonly root: string;
  private readonly resolver: VaultPathResolver;
  private readonly index: VaultIndex;
  private readonly now: () => Date;

  private constructor(resolver: VaultPathResolver, options: VaultRepositoryOptions) {
    this.resolver = resolver;
    this.root = resolver.root;
    this.now = options.now ?? (() => new Date());
    const indexRelativePath = normalizeVaultPath(
      options.indexPath ?? '.oldfolio/cache/index.sqlite',
    );
    this.index = new VaultIndex(this.resolver.resolve(indexRelativePath).absolutePath);
  }

  static async open(root: string, options: VaultRepositoryOptions = {}): Promise<VaultRepository> {
    return new VaultRepository(await VaultPathResolver.create(root), options);
  }

  async initialize(): Promise<void> {
    for (const directory of LAYOUT) await this.ensureDirectory(directory);
    await this.recoverInterruptedChangeSets();
    for (const [filePath, content] of Object.entries(INITIAL_DOCUMENTS)) {
      if ((await this.currentRevision(filePath)) === null)
        await this.atomicWrite(filePath, content);
    }
  }

  async scanDocuments(): Promise<VaultFileSnapshot[]> {
    const discovered: string[] = [];
    await this.walkMarkdown('', discovered);
    discovered.sort((left, right) => left.localeCompare(right));
    return Promise.all(discovered.map(async (filePath) => this.read(filePath)));
  }

  async read(relativePath: string): Promise<VaultFileSnapshot> {
    const resolved = this.resolver.resolve(relativePath);
    await this.resolver.assertNoSymlinks(resolved.relativePath);
    let stat;
    let bytes: Buffer;
    try {
      stat = await lstat(resolved.absolutePath);
      if (stat.isSymbolicLink())
        throw new VaultSymlinkError(`Refusing symbolic link: ${relativePath}`);
      if (!stat.isFile()) throw new VaultNotFoundError(resolved.relativePath);
      bytes = await readFile(resolved.absolutePath);
    } catch (error) {
      if (isMissing(error)) throw new VaultNotFoundError(resolved.relativePath);
      throw error;
    }
    return {
      path: resolved.relativePath,
      bytes,
      text: bytes.toString('utf8'),
      revision: hashBytes(bytes),
      size: bytes.byteLength,
      modifiedAt: stat.mtime,
    };
  }

  async write(
    relativePath: string,
    content: string | Uint8Array,
    expectedRevision: string | null,
  ): Promise<VaultFileSnapshot> {
    const normalized = normalizeVaultPath(relativePath);
    await this.assertRevision(normalized, expectedRevision);
    await this.atomicWrite(normalized, content);
    return this.read(normalized);
  }

  async remove(relativePath: string, expectedRevision: string): Promise<void> {
    const normalized = normalizeVaultPath(relativePath);
    await this.assertRevision(normalized, expectedRevision);
    const resolved = this.resolver.resolve(normalized);
    await this.resolver.assertNoSymlinks(normalized);
    await rm(resolved.absolutePath);
  }

  async rebuildIndex(): Promise<IndexRebuildResult> {
    const snapshots = await this.scanDocuments();
    const knownPaths = new Set(snapshots.map((snapshot) => snapshot.path));
    const documents: PreparedDocument[] = snapshots.map((snapshot) => {
      const metadata = extractMarkdownMetadata(snapshot.text);
      return {
        snapshot,
        metadata,
        resolvedLinks: metadata.links.map((link) => ({
          targetPath: resolveMarkdownTarget(snapshot.path, link.target, knownPaths) ?? link.target,
          raw: link.raw,
          kind: link.kind,
          ...(link.anchor ? { anchor: link.anchor } : {}),
          ...(link.label ? { label: link.label } : {}),
        })),
      };
    });
    return this.index.rebuild(documents);
  }

  async search(query: string, limit = 20): Promise<SearchResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('Search limit must be an integer between 1 and 1000');
    }
    return this.index.search(query, limit);
  }

  async backlinks(relativePath: string): Promise<Backlink[]> {
    return this.index.backlinks(normalizeVaultPath(relativePath));
  }

  async revision(): Promise<string> {
    const snapshots = await this.scanDocuments();
    const digest = createHash('sha256');
    for (const snapshot of snapshots)
      digest.update(snapshot.path).update('\0').update(snapshot.revision).update('\0');
    return digest.digest('hex');
  }

  async applyChangeSet(changeSet: WikiChangeSet): Promise<AppliedChangeSet> {
    if (changeSet.riskLevel === 'L4' || changeSet.items.some((item) => item.riskLevel === 'L4')) {
      throw new VaultHistoryError('L4 change sets are prohibited in Oldfolio v1');
    }
    const operations = changeSet.items.map((item) => item.operation);
    this.validateOperationSet(operations);

    for (const revision of changeSet.baseRevisions) {
      await this.assertRevision(revision.path, revisionHash(revision));
    }
    for (const operation of operations) await this.validateOperationRevision(operation);

    const affected = new Set<string>();
    for (const operation of operations) {
      affected.add(operationPath(operation));
      if (operation.kind === 'move') affected.add(operation.toPath);
    }
    const before = await this.captureStates([...affected]);
    const historyId = `${this.now().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
    const record: VaultHistoryRecord = {
      version: 1,
      id: historyId,
      changeSetId: changeSet.id,
      createdAt: this.now().toISOString(),
      before,
      after: [],
      status: 'applying',
    };

    await this.writeHistory(record);
    try {
      for (const operation of operations) await this.applyOperation(operation);
      record.after = await this.captureStates([...affected]);
      record.status = 'applied';
      await this.writeHistory(record);
    } catch (error) {
      try {
        await this.restoreStates(before);
        record.status = 'rolled_back';
        record.rolledBackAt = this.now().toISOString();
        await this.writeHistory(record);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Change set failed and rollback was incomplete',
        );
      }
      throw error;
    }

    return {
      historyId,
      revision: await this.revision(),
      appliedAt: record.createdAt,
      operations: operations.length,
    };
  }

  async undo(historyId: string): Promise<UndoResult> {
    const safeId = historyId.replaceAll(/[^\w.-]/g, '');
    if (safeId !== historyId || !safeId) throw new VaultHistoryError('Invalid history id');
    const historyPath = `.oldfolio/history/${safeId}.json`;
    let record: VaultHistoryRecord;
    try {
      record = JSON.parse((await this.read(historyPath)).text) as VaultHistoryRecord;
    } catch (error) {
      throw new VaultHistoryError(`Cannot read history record ${historyId}`, { cause: error });
    }
    if (record.version !== 1 || record.id !== historyId || record.status !== 'applied') {
      throw new VaultHistoryError(`History record cannot be undone: ${historyId}`);
    }
    for (const state of record.after) await this.assertRevision(state.path, state.revision);

    const current = await this.captureStates(record.after.map((state) => state.path));
    try {
      await this.restoreStates(record.before);
      record.status = 'undone';
      const undoneAt = this.now().toISOString();
      record.undoneAt = undoneAt;
      const currentRevision = (await this.read(historyPath)).revision;
      await this.write(historyPath, `${JSON.stringify(record, null, 2)}\n`, currentRevision);
      return { historyId, revision: await this.revision(), undoneAt };
    } catch (error) {
      await this.restoreStates(current);
      throw error;
    }
  }

  close(): void {
    this.index.close();
  }

  private async walkMarkdown(relativeDirectory: string, found: string[]): Promise<void> {
    const absoluteDirectory = relativeDirectory
      ? this.resolver.resolve(relativeDirectory).absolutePath
      : this.root;
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new VaultSymlinkError(`Symbolic links are not allowed: ${relativePath}`);
      if (!relativeDirectory && entry.name === '.oldfolio') continue;
      if (entry.isDirectory()) await this.walkMarkdown(relativePath, found);
      else if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.md')) {
        found.push(normalizeVaultPath(relativePath));
      }
    }
  }

  private async ensureDirectory(relativeDirectory: string): Promise<void> {
    const normalized = normalizeVaultPath(relativeDirectory);
    let partial = '';
    for (const segment of normalized.split('/')) {
      partial = partial ? `${partial}/${segment}` : segment;
      const resolved = this.resolver.resolve(partial);
      await this.resolver.assertNoSymlinks(partial, false);
      try {
        await mkdir(resolved.absolutePath);
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          (error as NodeJS.ErrnoException).code === 'EEXIST'
        )) {
          throw error;
        }
      }
      const stat = await lstat(resolved.absolutePath);
      if (stat.isSymbolicLink())
        throw new VaultSymlinkError(`Symbolic links are not allowed: ${partial}`);
      if (!stat.isDirectory())
        throw new VaultSymlinkError(`Expected directory in vault path: ${partial}`);
    }
  }

  private async currentRevision(relativePath: string): Promise<string | null> {
    try {
      return (await this.read(relativePath)).revision;
    } catch (error) {
      if (error instanceof VaultNotFoundError) return null;
      throw error;
    }
  }

  private async assertRevision(
    relativePath: string,
    expectedRevision: string | null,
  ): Promise<void> {
    const normalized = normalizeVaultPath(relativePath);
    const actual = await this.currentRevision(normalized);
    if (actual !== expectedRevision)
      throw new VaultConflictError(normalized, expectedRevision, actual);
  }

  private async atomicWrite(relativePath: string, content: string | Uint8Array): Promise<void> {
    const resolved = this.resolver.resolve(relativePath);
    const parent = path.posix.dirname(resolved.relativePath);
    if (parent !== '.') await this.ensureDirectory(parent);
    await this.resolver.assertNoSymlinks(resolved.relativePath, false);
    const temporary = `${resolved.absolutePath}.oldfolio-${randomUUID()}.tmp`;
    const handle = await openFile(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.resolver.assertNoSymlinks(resolved.relativePath);
      await rename(temporary, resolved.absolutePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private validateOperationSet(operations: WikiFileOperation[]): void {
    const touched = new Set<string>();
    for (const operation of operations) {
      const source = normalizeVaultPath(operationPath(operation));
      if (touched.has(source))
        throw new VaultHistoryError(`Change set touches ${source} more than once`);
      touched.add(source);
      if (operation.kind === 'move') {
        const destination = normalizeVaultPath(operation.toPath);
        if (touched.has(destination))
          throw new VaultHistoryError(`Change set touches ${destination} more than once`);
        touched.add(destination);
      }
    }
  }

  private async validateOperationRevision(operation: WikiFileOperation): Promise<void> {
    if (operation.kind === 'create') {
      await this.assertRevision(operation.path, null);
      if (hashBytes(Buffer.from(operation.content, 'utf8')) !== operation.contentHash) {
        throw new VaultHistoryError(
          `Content hash does not match create operation for ${operation.path}`,
        );
      }
      return;
    }
    const source = operationPath(operation);
    if (normalizeVaultPath(operation.baseRevision.path) !== normalizeVaultPath(source)) {
      throw new VaultHistoryError(`Base revision path does not match operation path: ${source}`);
    }
    await this.assertRevision(source, revisionHash(operation.baseRevision));
    if (
      operation.kind === 'update' &&
      hashBytes(Buffer.from(operation.content, 'utf8')) !== operation.contentHash
    ) {
      throw new VaultHistoryError(
        `Content hash does not match update operation for ${operation.path}`,
      );
    }
    if (operation.kind === 'move') await this.assertRevision(operation.toPath, null);
  }

  private async applyOperation(operation: WikiFileOperation): Promise<void> {
    switch (operation.kind) {
      case 'create':
      case 'update':
        await this.atomicWrite(operation.path, operation.content);
        break;
      case 'delete':
        await rm(this.resolver.resolve(operation.path).absolutePath);
        break;
      case 'move': {
        const destination = this.resolver.resolve(operation.toPath);
        const parent = path.posix.dirname(operation.toPath);
        if (parent !== '.') await this.ensureDirectory(parent);
        await this.resolver.assertNoSymlinks(operation.fromPath);
        await this.resolver.assertNoSymlinks(operation.toPath);
        await rename(
          this.resolver.resolve(operation.fromPath).absolutePath,
          destination.absolutePath,
        );
        break;
      }
    }
  }

  private async captureStates(paths: string[]): Promise<HistoryFileState[]> {
    const states: HistoryFileState[] = [];
    for (const filePath of [...new Set(paths)].sort()) {
      try {
        const snapshot = await this.read(filePath);
        states.push({
          path: snapshot.path,
          revision: snapshot.revision,
          content: Buffer.from(snapshot.bytes).toString('base64'),
        });
      } catch (error) {
        if (error instanceof VaultNotFoundError)
          states.push({ path: normalizeVaultPath(filePath), revision: null, content: null });
        else throw error;
      }
    }
    return states;
  }

  private async restoreStates(states: HistoryFileState[]): Promise<void> {
    for (const state of states) {
      if (state.content === null) {
        const resolved = this.resolver.resolve(state.path);
        await this.resolver.assertNoSymlinks(state.path);
        await rm(resolved.absolutePath, { force: true });
      } else {
        await this.atomicWrite(state.path, Buffer.from(state.content, 'base64'));
      }
    }
  }

  private async writeHistory(record: VaultHistoryRecord): Promise<void> {
    await this.atomicWrite(
      `.oldfolio/history/${record.id}.json`,
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }

  private async recoverInterruptedChangeSets(): Promise<void> {
    const historyDirectory = this.resolver.resolve('.oldfolio/history').absolutePath;
    const entries = await readdir(historyDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new VaultSymlinkError(
          `Symbolic links are not allowed: .oldfolio/history/${entry.name}`,
        );
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const historyPath = `.oldfolio/history/${entry.name}`;
      let record: VaultHistoryRecord;
      try {
        record = JSON.parse((await this.read(historyPath)).text) as VaultHistoryRecord;
      } catch (error) {
        throw new VaultHistoryError(`Invalid history record: ${historyPath}`, { cause: error });
      }
      if (record.version !== 1 || `${record.id}.json` !== entry.name) {
        throw new VaultHistoryError(`Invalid history record identity: ${historyPath}`);
      }
      if (record.status !== 'applying') continue;
      await this.restoreStates(record.before);
      record.status = 'rolled_back';
      record.rolledBackAt = this.now().toISOString();
      await this.writeHistory(record);
    }
  }
}
