import type { VaultPath } from './common.js';
import type { DocumentRevision, SyncMode } from './vault.js';

export type SyncAction = 'upload' | 'download' | 'delete-local' | 'delete-remote' | 'conflict';

export interface SyncPlanItem {
  readonly path: VaultPath;
  readonly action: SyncAction;
  readonly baseRevision?: DocumentRevision;
}

export interface SyncPlan {
  readonly mode: SyncMode;
  readonly items: readonly SyncPlanItem[];
}

export interface SyncBackend {
  readonly mode: SyncMode;
  plan(signal?: AbortSignal): Promise<SyncPlan>;
  execute(plan: SyncPlan, signal?: AbortSignal): Promise<void>;
}

