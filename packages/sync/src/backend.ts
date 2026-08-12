import type { SyncConfig } from './config.js';

export interface SyncPlanItem {
  readonly path: string;
  readonly action: 'upload' | 'download' | 'delete-local' | 'delete-remote' | 'conflict';
  readonly baseRevision?: string;
}

export interface SyncPlan {
  readonly mode: SyncConfig['mode'];
  readonly items: readonly SyncPlanItem[];
}

export interface SyncBackend {
  readonly mode: SyncConfig['mode'];
  plan(signal?: AbortSignal): Promise<SyncPlan>;
  execute(plan: SyncPlan, signal?: AbortSignal): Promise<void>;
}
