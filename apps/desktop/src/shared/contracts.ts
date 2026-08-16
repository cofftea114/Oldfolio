export interface VaultSummary {
  root: string;
  name: string;
  documentCount: number;
}

export type DocumentCategory = 'knowledge' | 'transcript' | 'internal';

export interface DocumentSummary {
  path: string;
  title: string;
  category: DocumentCategory;
  revision: string;
  updatedAt: string;
  tags: string[];
}

export interface VaultDocument extends DocumentSummary {
  content: string;
  links: string[];
}

export interface DocumentDeletionResult {
  cancelled: boolean;
  historyId?: string;
  path?: string;
}

export interface SearchHit {
  path: string;
  title: string;
  category: Exclude<DocumentCategory, 'internal'>;
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
  transcriptSource?: 'embedded_subtitle' | 'speech_recognition';
}

export interface TranscriptPlaybackSegment {
  startMs: number;
  label: string;
  text: string;
  speaker?: string;
}

export interface TranscriptPlaybackSummary {
  title: string;
  resource: string;
  mediaUrl: string;
  mediaKind: 'audio' | 'video';
  segments: TranscriptPlaybackSegment[];
}

export type AISummaryTemplate =
  | 'course'
  | 'interview'
  | 'podcast'
  | 'tutorial'
  | 'meeting'
  | 'news-commentary'
  | 'debate'
  | 'review';

export type AILocalProviderId = 'ollama' | 'openai-compatible';

export interface AISettingsSummary {
  providerId: AILocalProviderId;
  endpoint: string;
  model: string;
  configured: boolean;
}

export interface AIModelSummary {
  id: string;
  displayName: string;
}

export interface AISummaryPreparation {
  sourcePath: string;
  sourceRevision: string;
  suggestedTemplate: AISummaryTemplate;
  templateConfidence: number;
  availableTemplates: AISummaryTemplate[];
  segmentCount: number;
  sourceCharacters: number;
  estimatedInputTokens: number;
  workingDocumentPath: string;
  processingMode: 'direct' | 'document-reader';
  estimatedModelCalls: number;
  endpoint: string;
  model: string;
  providerId: AILocalProviderId;
  dataDestination: 'local_ollama' | 'local_lm_studio';
  estimatedCost: 0;
  sourcePreview: string;
}

export interface AIChangeCitationSummary {
  id: string;
  resource: string;
  excerpt?: string;
  startMs?: number;
  endMs?: number;
}

export interface AIPendingSummaryChange {
  id: string;
  riskLevel: 'L1' | 'L2';
  targetPath: string;
  sourcePath: string;
  template: AISummaryTemplate;
  content: string;
  diff: string;
  citations: AIChangeCitationSummary[];
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AIAppliedChange {
  historyId: string;
  targetPath: string;
  document: VaultDocument;
}

export interface OldfolioDesktopApi {
  chooseVault(): Promise<VaultSummary | null>;
  createVault(): Promise<VaultSummary | null>;
  listDocuments(): Promise<DocumentSummary[]>;
  createDocument(title: string): Promise<VaultDocument>;
  readDocument(path: string): Promise<VaultDocument>;
  saveDocument(path: string, content: string, expectedRevision: string): Promise<VaultDocument>;
  deleteDocument(path: string, expectedRevision: string): Promise<DocumentDeletionResult>;
  undoDocumentDeletion(historyId: string): Promise<VaultDocument>;
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
  getTranscriptPlayback(path: string): Promise<TranscriptPlaybackSummary | null>;
  getAISettings(): Promise<AISettingsSummary>;
  probeLocalAI(input: { providerId: AILocalProviderId; endpoint: string }): Promise<AIModelSummary[]>;
  saveAISettings(input: {
    providerId: AILocalProviderId;
    endpoint: string;
    model: string;
  }): Promise<AISettingsSummary>;
  prepareAISummary(path: string): Promise<AISummaryPreparation>;
  generateAISummary(input: {
    path: string;
    sourceRevision: string;
    template: AISummaryTemplate;
  }): Promise<AIPendingSummaryChange>;
  applyAIChangeSet(changeSetId: string): Promise<AIAppliedChange>;
  undoAIChangeSet(historyId: string): Promise<{ historyId: string; sourcePath?: string }>;
}
