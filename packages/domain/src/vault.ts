import type { ContentHash, ISODateTime, VaultPath } from './common.js';

/** How a document subtree is interpreted. A vault can contain both modes. */
export type VaultMode = 'lossless_markdown' | 'strict_okf';

/** Exactly one sync mode can be active for a vault. */
export type SyncMode = 'none' | 'webdav_e2ee' | 'folder_compat';

/**
 * Immutable identity for one observed version of a document.
 * `revisionId` is implementation-defined; `contentHash` is the portable guard.
 */
export interface DocumentRevision {
  readonly path: VaultPath;
  readonly revisionId: string;
  readonly contentHash: ContentHash;
  readonly modifiedAt: ISODateTime;
  readonly byteLength: number;
}

