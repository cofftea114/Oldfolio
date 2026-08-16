import type { ContentHash, ISODateTime, VaultPath } from './common.js';
import type { AITranscriptSegment } from './ai.js';

export type MediaJobStage =
  | 'queued'
  | 'probing'
  | 'extracting_subtitles'
  | 'extracting_audio'
  | 'transcribing'
  | 'compiling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface MediaJobCheckpoint {
  readonly stage: MediaJobStage;
  readonly updatedAt: ISODateTime;
  readonly progress: number;
  readonly artifactPath?: VaultPath;
  readonly artifactHash?: ContentHash;
  readonly chunkIndex?: number;
  readonly chunkCount?: number;
}

export interface LocalMediaTranscriptionRequest {
  readonly kind: 'local_transcription';
  readonly sourceTitle: string;
  readonly importedFrom?: string;
  readonly modelId: string;
  readonly modelHash: ContentHash;
  readonly language?: string;
  readonly chunkDurationMs: number;
}

export interface OnlineMediaTranscriptionRequest {
  readonly kind: 'online_transcription';
  readonly sourceKind?: 'local-file' | 'remote-url';
  readonly sourceTitle: string;
  readonly importedFrom: string;
  readonly providerId: 'openai-compatible' | 'tencent-asr';
  readonly endpointHost: string;
  readonly transcriptionModel: string;
  readonly secretRef: string;
  readonly inputMode: 'chunks';
  readonly language?: string;
  readonly chunkDurationMs: number;
}

export type MediaTranscriptionRequest = LocalMediaTranscriptionRequest | OnlineMediaTranscriptionRequest;

export interface MediaJobError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface MediaJobRecord {
  readonly version: 1;
  readonly id: string;
  readonly sourceUri: string;
  readonly sourceHash: ContentHash;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly stage: MediaJobStage;
  readonly attempts: number;
  readonly checkpoints: readonly MediaJobCheckpoint[];
  readonly request?: MediaTranscriptionRequest;
  readonly transcriptSegments?: readonly AITranscriptSegment[];
  readonly outputPaths?: readonly VaultPath[];
  readonly error?: MediaJobError;
}

export interface MediaToolDescriptor {
  readonly id: string;
  readonly executablePath: string;
  readonly version?: string;
}

export interface LocalModelDescriptor {
  readonly id: string;
  readonly filePath: string;
  readonly sha256: ContentHash;
  readonly license: string;
  readonly sourceUrl: string;
}
