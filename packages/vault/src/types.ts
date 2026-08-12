export type VaultRelativePath = string;

export interface VaultFileSnapshot {
  path: VaultRelativePath;
  bytes: Uint8Array;
  text: string;
  revision: string;
  size: number;
  modifiedAt: Date;
}

export interface MarkdownHeading {
  level: number;
  text: string;
  line: number;
}

export interface MarkdownLink {
  kind: 'wikilink' | 'markdown';
  raw: string;
  target: string;
  anchor?: string;
  label?: string;
  embedded: boolean;
}

export interface MarkdownMetadata {
  title?: string;
  headings: MarkdownHeading[];
  links: MarkdownLink[];
  tags: string[];
}

export interface IndexedDocument {
  path: VaultRelativePath;
  revision: string;
  title: string;
}

export interface SearchResult extends IndexedDocument {
  score: number;
  excerpt: string;
}

export interface Backlink {
  sourcePath: VaultRelativePath;
  targetPath: VaultRelativePath;
  raw: string;
  kind: MarkdownLink['kind'];
  anchor?: string;
  label?: string;
}

export interface IndexRebuildResult {
  documents: number;
  links: number;
  tags: number;
  headings: number;
}

export interface AppliedChangeSet {
  historyId: string;
  revision: string;
  appliedAt: string;
  operations: number;
}

export interface UndoResult {
  historyId: string;
  revision: string;
  undoneAt: string;
}

export interface VaultRepositoryOptions {
  indexPath?: VaultRelativePath;
  now?: () => Date;
}
