import type { JsonSchema, OperationContext } from './common.js';

export type AICapability = 'chat' | 'embedding' | 'transcription' | 'translation';

export interface AIModelDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly AICapability[];
  readonly contextWindow?: number;
  readonly local: boolean;
}

export interface AIProviderConfig {
  readonly providerId: string;
  readonly endpoint: string;
  readonly model: string;
  /** Reference to an OS keychain entry, never the secret itself. */
  readonly secretRef?: string;
}

/** Supplies a secret only for the lifetime of one invocation. */
export interface AIInvocationContext extends OperationContext {
  resolveSecret(secretRef: string): Promise<string | undefined>;
}

export type AIMessageRole = 'system' | 'user' | 'assistant';

export interface AIMessage {
  readonly role: AIMessageRole;
  readonly content: string;
}

export interface AICompletionRequest {
  readonly model: string;
  readonly messages: readonly AIMessage[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly responseFormat?: 'text' | 'json';
  readonly responseSchema?: JsonSchema;
}

export interface AIUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedCost?: number;
  readonly currency?: string;
}

export interface AICompletion {
  readonly content: string;
  readonly model: string;
  readonly finishReason: 'stop' | 'length' | 'content_filter' | 'error' | 'unknown';
  readonly usage?: AIUsage;
}

export interface AIEmbeddingRequest {
  readonly model: string;
  readonly inputs: readonly string[];
}

export interface AIEmbeddingResult {
  readonly model: string;
  readonly vectors: readonly (readonly number[])[];
  readonly usage?: AIUsage;
}

export interface AITranscriptionRequest {
  readonly model: string;
  readonly mediaUri: string;
  /** Duration of the controlled media input, used when a provider cannot return granular timestamps. */
  readonly durationMs?: number;
  readonly language?: string;
  readonly prompt?: string;
}

export interface AITranscriptSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker?: string;
}

export interface AITranscriptionResult {
  readonly language?: string;
  readonly text: string;
  readonly segments: readonly AITranscriptSegment[];
  readonly usage?: AIUsage;
}

export interface AITranslationRequest {
  readonly model: string;
  readonly text: string;
  readonly sourceLanguage?: string;
  readonly targetLanguage: string;
}

export interface AITranslationResult {
  readonly text: string;
  readonly sourceLanguage?: string;
  readonly targetLanguage: string;
  readonly usage?: AIUsage;
}

export interface AIProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly AICapability[];
  listModels(config: AIProviderConfig, context?: AIInvocationContext): Promise<readonly AIModelDescriptor[]>;
  complete(
    config: AIProviderConfig,
    request: AICompletionRequest,
    context?: AIInvocationContext,
  ): Promise<AICompletion>;
  embed?(
    config: AIProviderConfig,
    request: AIEmbeddingRequest,
    context?: AIInvocationContext,
  ): Promise<AIEmbeddingResult>;
  transcribe?(
    config: AIProviderConfig,
    request: AITranscriptionRequest,
    context?: AIInvocationContext,
  ): Promise<AITranscriptionResult>;
  translate?(
    config: AIProviderConfig,
    request: AITranslationRequest,
    context?: AIInvocationContext,
  ): Promise<AITranslationResult>;
}
