export interface HistoryFileState {
  path: string;
  revision: string | null;
  content: string | null;
}

export interface VaultHistoryRecord {
  version: 1;
  id: string;
  changeSetId: string | null;
  createdAt: string;
  before: HistoryFileState[];
  after: HistoryFileState[];
  status: 'applying' | 'applied' | 'rolled_back' | 'undone';
  rolledBackAt?: string;
  undoneAt?: string;
}
