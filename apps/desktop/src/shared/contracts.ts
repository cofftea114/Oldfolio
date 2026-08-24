export interface VaultSummary {
  root: string;
  name: string;
  documentCount: number;
}

export type DocumentCategory = 'note' | 'knowledge' | 'summary' | 'concept' | 'qa' | 'transcript' | 'internal';

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
  ytDlp: MediaToolStatus;
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
  canDelete: boolean;
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
  contextWindow: number;
  configured: boolean;
}

export type AISummaryExecutionTarget = 'local' | 'online';
export type AISummaryMode = 'fast' | 'deep';
export type AISummaryLanguage = 'auto' | 'zh-CN' | 'en';

export interface OnlineAISettingsSummary {
  version: 1;
  preset: OnlineSummaryPreset;
  endpoint: string;
  confirmedHost: string;
  chatModel: string;
  transcriptionModel: string;
  contextWindow: number;
  secretRef: string;
  configured: boolean;
  keyAvailable: boolean;
  keyPersisted: boolean;
  secureStorageAvailable: boolean;
  keyAvailablePresets: OnlineSummaryPreset[];
  keyPersistedPresets: OnlineSummaryPreset[];
}

export type OnlineSummaryPreset = 'custom' | 'openai' | 'deepseek' | 'kimi' | 'glm' | 'minimax' | 'grok' | 'qwen' | 'gemini' | 'openrouter';
export type CloudTranscriptionProviderId = 'openai-compatible' | 'tencent-asr';

export const DEFAULT_TENCENT_ASR_ENGINE = '16k_zh' as const;
export const TENCENT_ASR_ENGINES = [
  { id: '16k_zh', label: '中文普通话通用（推荐）', billing: 'free-package' },
  { id: '16k_zh-PY', label: '中文、英语、粤语混合', billing: 'free-package' },
  { id: '16k_en', label: '英语', billing: 'free-package' },
  { id: '16k_yue', label: '粤语', billing: 'free-package' },
  { id: '16k_ja', label: '日语', billing: 'free-package' },
  { id: '16k_ko', label: '韩语', billing: 'free-package' },
  { id: '16k_zh_en', label: '中英及多方言 · 大模型 1.0', billing: 'paid' },
  { id: '16k_zh_en_2.0', label: '中英及多方言 · 大模型 2.0', billing: 'paid' },
  { id: '16k_multi_lang', label: '多语种 · 大模型 1.0', billing: 'paid' },
] as const;
export type TencentASREngineModel = typeof TENCENT_ASR_ENGINES[number]['id'];

export function isTencentASREngine(value: string): value is TencentASREngineModel {
  return TENCENT_ASR_ENGINES.some((engine) => engine.id === value);
}

export interface CloudTranscriptionSettingsSummary {
  version: 1;
  providerId: CloudTranscriptionProviderId;
  model: string;
  region: string;
  secretRef: string;
  configured: boolean;
  credentialAvailable: boolean;
  credentialPersisted: boolean;
  secureStorageAvailable: boolean;
  endpointHost: string;
  inputMode: 'chunks';
}

export interface AIModelSummary {
  id: string;
  displayName: string;
  contextWindow?: number;
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
  mode: AISummaryMode;
  requestedOutputLanguage: AISummaryLanguage;
  outputLanguage: Exclude<AISummaryLanguage, 'auto'>;
  contextWindow: number;
  reservedOutputTokens: number;
  analysisOutputTokens: number;
  inputTokenBudget: number;
  windowTokenBudget: number;
  workingDocumentPath: string;
  processingMode: 'direct' | 'document-reader';
  estimatedModelCalls: number;
  endpoint: string;
  model: string;
  providerId: AILocalProviderId;
  executionTarget: AISummaryExecutionTarget;
  dataDestination: 'local_ollama' | 'local_lm_studio' | 'online_openai_compatible';
  estimatedCost: 0 | null;
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
  outputLanguage: Exclude<AISummaryLanguage, 'auto'>;
  contextWindow: number;
  contextWindowAdjusted: boolean;
  content: string;
  diff: string;
  citations: AIChangeCitationSummary[];
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AIConceptPreparation {
  sourcePath: string;
  sourceRevision: string;
  sourceTitle: string;
  existingConceptCount: number;
  sourceCharacters: number;
  endpoint: string;
  model: string;
  providerId: AILocalProviderId;
  executionTarget: AISummaryExecutionTarget;
  dataDestination: AISummaryPreparation['dataDestination'];
  estimatedCost: 0 | null;
  sourcePreview: string;
}

export interface AIPendingConceptChange {
  id: string;
  riskLevel: 'L1' | 'L2';
  targetPath: string;
  sourcePath: string;
  createdCount: number;
  updatedCount: number;
  conceptTitles: string[];
  files: { path: string; action: 'create' | 'update'; content: string }[];
  diff: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AIWikiQuestionPreparation {
  id: string;
  question: string;
  executionTarget: AISummaryExecutionTarget;
  endpoint: string;
  model: string;
  providerId: AILocalProviderId;
  estimatedCost: 0 | null;
  usedTranscriptFallback: boolean;
  sources: {
    path: string;
    title: string;
    kind: 'wiki' | 'transcript';
    revision: string;
    preview: string;
  }[];
}

export interface AIWikiAnswer {
  id: string;
  question: string;
  markdown: string;
  model: string;
  sourcePaths: string[];
  usedTranscriptFallback: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AIPendingWikiAnswerSave {
  id: string;
  riskLevel: 'L1' | 'L2';
  targetPath: string;
  content: string;
  diff: string;
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
  chooseMediaTool(kind: 'ffmpeg' | 'whisper' | 'yt-dlp'): Promise<MediaSettingsSummary>;
  importWhisperModel(input: {
    id: string;
    license: string;
    sourceUrl: string;
    licenseAccepted: boolean;
    expectedSha256?: string;
  }): Promise<MediaSettingsSummary>;
  transcribeMedia(input: { modelId: string; language?: string }): Promise<MediaTranscriptionResult>;
  transcribeOnlineMediaLocally(input: { url: string; modelId: string; language?: string; platformAccessConfirmed: boolean }): Promise<MediaTranscriptionResult>;
  transcribeCloudMedia(input: { language?: string }): Promise<MediaTranscriptionResult>;
  transcribeOnlineMedia(input: { url: string; language?: string; platformAccessConfirmed?: boolean }): Promise<MediaTranscriptionResult>;
  retryMediaJob(jobId: string): Promise<MediaTranscriptionResult>;
  deleteMediaJob(jobId: string): Promise<{ cancelled: boolean }>;
  listMediaJobs(): Promise<MediaJobSummary[]>;
  getTranscriptPlayback(path: string): Promise<TranscriptPlaybackSummary | null>;
  getAISettings(): Promise<AISettingsSummary>;
  getOnlineAISettings(): Promise<OnlineAISettingsSummary>;
  getCloudTranscriptionSettings(): Promise<CloudTranscriptionSettingsSummary>;
  probeLocalAI(input: { providerId: AILocalProviderId; endpoint: string }): Promise<AIModelSummary[]>;
  probeOnlineAI(input: {
    endpoint: string;
    apiKey: string;
    hostConfirmed: boolean;
  }): Promise<AIModelSummary[]>;
  saveAISettings(input: {
    providerId: AILocalProviderId;
    endpoint: string;
    model: string;
    contextWindow: number;
  }): Promise<AISettingsSummary>;
  saveOnlineAISettings(input: {
    preset?: OnlineSummaryPreset;
    endpoint: string;
    chatModel: string;
    transcriptionModel?: string;
    contextWindow: number;
    apiKey: string;
    hostConfirmed: boolean;
  }): Promise<OnlineAISettingsSummary>;
  clearOnlineAIKey(preset: OnlineSummaryPreset): Promise<OnlineAISettingsSummary>;
  saveCloudTranscriptionSettings(input:
    | { providerId: 'openai-compatible'; model: string }
    | { providerId: 'tencent-asr'; region: string; engineModelType: TencentASREngineModel; secretId: string; secretKey: string }
  ): Promise<CloudTranscriptionSettingsSummary>;
  clearCloudTranscriptionCredentials(): Promise<CloudTranscriptionSettingsSummary>;
  prepareAISummary(
    path: string,
    executionTarget: AISummaryExecutionTarget,
    mode: AISummaryMode,
    outputLanguage: AISummaryLanguage,
  ): Promise<AISummaryPreparation>;
  generateAISummary(input: {
    path: string;
    sourceRevision: string;
    template: AISummaryTemplate;
    executionTarget: AISummaryExecutionTarget;
    mode: AISummaryMode;
    outputLanguage: AISummaryLanguage;
  }): Promise<AIPendingSummaryChange>;
  prepareAIConcepts(path: string, executionTarget: AISummaryExecutionTarget): Promise<AIConceptPreparation>;
  generateAIConcepts(input: {
    path: string;
    sourceRevision: string;
    executionTarget: AISummaryExecutionTarget;
  }): Promise<AIPendingConceptChange>;
  prepareWikiQuestion(input: {
    question: string;
    executionTarget: AISummaryExecutionTarget;
  }): Promise<AIWikiQuestionPreparation>;
  answerWikiQuestion(preparationId: string): Promise<AIWikiAnswer>;
  prepareSaveWikiAnswer(answerId: string): Promise<AIPendingWikiAnswerSave>;
  applyWikiAnswerChangeSet(changeSetId: string): Promise<AIAppliedChange>;
  undoWikiAnswerChangeSet(historyId: string): Promise<{ historyId: string; sourcePath?: string }>;
  applyAIChangeSet(changeSetId: string): Promise<AIAppliedChange>;
  undoAIChangeSet(historyId: string): Promise<{ historyId: string; sourcePath?: string }>;
}
