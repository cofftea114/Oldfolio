export interface VaultSummary {
  root: string;
  name: string;
  documentCount: number;
}

export interface DocumentSummary {
  path: string;
  title: string;
  revision: string;
  updatedAt: string;
  tags: string[];
}

export interface VaultDocument extends DocumentSummary {
  content: string;
  links: string[];
}

export interface SearchHit {
  path: string;
  title: string;
  excerpt: string;
  score: number;
}

export interface FeedImportResult {
  created: boolean;
  snapshotId: string;
  document: VaultDocument;
}

export interface CaptionImportResult {
  cancelled: boolean;
  createdSource?: boolean;
  createdTranscript?: boolean;
  jobId?: string;
  transcript?: VaultDocument;
}

export interface MediaToolStatus {
  configured: boolean;
  available: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export interface InstalledModelSummary {
  id: string;
  sha256: string;
  license: string;
  sourceUrl: string;
  byteLength: number;
  importedAt: string;
}

export interface MediaSettingsSummary {
  ffmpeg: MediaToolStatus;
  whisper: MediaToolStatus;
  models: InstalledModelSummary[];
}

export interface MediaJobSummary {
  id: string;
  sourceUri: string;
  stage: string;
  progress: number;
  updatedAt: string;
  error?: string;
  canRetry: boolean;
  attempts: number;
  completedChunks: number;
  chunkCount?: number;
}

export interface MediaTranscriptionResult {
  cancelled: boolean;
  jobId?: string;
  transcript?: VaultDocument;
}

export interface OldfolioDesktopApi {
  chooseVault(): Promise<VaultSummary | null>;
  createVault(): Promise<VaultSummary | null>;
  listDocuments(): Promise<DocumentSummary[]>;
  readDocument(path: string): Promise<VaultDocument>;
  saveDocument(path: string, content: string, expectedRevision: string): Promise<VaultDocument>;
  search(query: string): Promise<SearchHit[]>;
  backlinks(path: string): Promise<DocumentSummary[]>;
  importFeed(url: string): Promise<FeedImportResult>;
  importCaptions(): Promise<CaptionImportResult>;
  getMediaSettings(): Promise<MediaSettingsSummary>;
  chooseMediaTool(kind: 'ffmpeg' | 'whisper'): Promise<MediaSettingsSummary>;
  importWhisperModel(input: {
    id: string;
    license: string;
    sourceUrl: string;
    licenseAccepted: boolean;
    expectedSha256?: string;
  }): Promise<MediaSettingsSummary>;
  transcribeMedia(input: { modelId: string; language?: string }): Promise<MediaTranscriptionResult>;
  retryMediaJob(jobId: string): Promise<MediaTranscriptionResult>;
  listMediaJobs(): Promise<MediaJobSummary[]>;
}
