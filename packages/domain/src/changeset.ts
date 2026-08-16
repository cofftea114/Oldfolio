import type { ContentHash, ISODateTime, VaultPath } from './common.js';
import type { DocumentRevision } from './vault.js';

export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export interface WikiCitation {
  readonly id: string;
  readonly sourceId: string;
  readonly resource: string;
  readonly title?: string;
  readonly excerpt?: string;
  readonly startMs?: number;
  readonly endMs?: number;
}

export type WikiFileOperation =
  | {
      readonly kind: 'create';
      readonly path: VaultPath;
      readonly content: string;
      readonly contentHash: ContentHash;
    }
  | {
      readonly kind: 'update';
      readonly path: VaultPath;
      readonly baseRevision: DocumentRevision;
      readonly content: string;
      readonly contentHash: ContentHash;
    }
  | {
      readonly kind: 'delete';
      readonly path: VaultPath;
      readonly baseRevision: DocumentRevision;
    }
  | {
      readonly kind: 'move';
      readonly fromPath: VaultPath;
      readonly toPath: VaultPath;
      readonly baseRevision: DocumentRevision;
    };

export interface WikiChangeItem {
  readonly id: string;
  readonly summary: string;
  readonly riskLevel: RiskLevel;
  readonly operation: WikiFileOperation;
  /** Unified diff for review. Full replacement content remains authoritative. */
  readonly diff: string;
  readonly citationIds: readonly string[];
}

export interface WikiChangeGenerator {
  readonly providerId: string;
  readonly model: string;
  readonly promptVersion: string;
}

export type WikiRollbackOperation =
  | {
      readonly kind: 'remove_created';
      readonly path: VaultPath;
      readonly expectedContentHash: ContentHash;
    }
  | {
      readonly kind: 'restore_content';
      readonly path: VaultPath;
      readonly content: string;
      readonly contentHash: ContentHash;
    }
  | {
      readonly kind: 'move_back';
      readonly fromPath: VaultPath;
      readonly toPath: VaultPath;
      readonly expectedContentHash: ContentHash;
    };

export interface WikiRollback {
  /** Fully materialized inverse operations, already ordered for rollback. */
  readonly operations: readonly WikiRollbackOperation[];
}

export interface WikiChangeSet {
  readonly id: string;
  readonly createdAt: ISODateTime;
  readonly baseRevisions: readonly DocumentRevision[];
  readonly sourceHashes: Readonly<Record<string, ContentHash>>;
  readonly generator: WikiChangeGenerator;
  readonly riskLevel: RiskLevel;
  readonly items: readonly WikiChangeItem[];
  readonly citations: readonly WikiCitation[];
  readonly rollback: WikiRollback;
}

export interface WikiCompilerInput {
  readonly baseRevisions: readonly DocumentRevision[];
  readonly sourceHashes: Readonly<Record<string, ContentHash>>;
  readonly sourceDocuments: Readonly<Record<string, string>>;
  readonly wikiDocuments: Readonly<Record<VaultPath, string>>;
  readonly instructions: string;
}

export interface WikiCompiler {
  compile(input: WikiCompilerInput): Promise<WikiChangeSet>;
}
