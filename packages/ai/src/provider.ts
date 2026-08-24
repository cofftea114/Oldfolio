import type {
  AICompletion,
  AICompletionRequest,
  AIInvocationContext,
  AIModelDescriptor,
  AIProvider,
  AIProviderConfig,
  AITranscriptionRequest,
  AITranscriptionResult,
  AICapability,
} from '@oldfolio/domain';
import { resolveEndpoint, validateAIEndpoint, type EndpointPolicy } from './endpoint-policy.js';

export type {
  AICompletion,
  AICompletionRequest,
  AIInvocationContext,
  AIMessage,
  AIMessageRole,
  AIModelDescriptor,
  AIProvider,
  AIProviderConfig,
} from '@oldfolio/domain';

export interface ProviderOptions {
  readonly endpointPolicy?: EndpointPolicy;
  readonly fetch?: typeof fetch;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly readMedia?: (
    uri: string,
    signal?: AbortSignal,
  ) => Promise<{ readonly bytes: Uint8Array; readonly fileName: string; readonly mimeType: string }>;
  /** Some OpenAI-compatible services support JSON objects but not strict JSON Schema response formats. */
  readonly structuredOutputMode?: 'json-schema' | 'json-object';
  /** Maps the shared per-request reasoning switch to a provider-specific request shape. */
  readonly reasoningDialect?: 'qwen' | 'deepseek' | 'openrouter';
  readonly defaultReasoningMode?: 'provider-default' | 'disabled' | 'enabled';
  /** Receive chat completions as OpenAI-compatible SSE to keep long remote generations active. */
  readonly streamChatCompletions?: boolean;
}

export interface AIProviderErrorOptions extends ErrorOptions {
  readonly requestTokens?: number;
  readonly availableContextTokens?: number;
}

export class AIProviderError extends Error {
  readonly requestTokens: number | undefined;
  readonly availableContextTokens: number | undefined;

  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    options?: AIProviderErrorOptions,
  ) {
    super(message, options);
    this.name = 'AIProviderError';
    this.requestTokens = options?.requestTokens;
    this.availableContextTokens = options?.availableContextTokens;
  }
}

function transportErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const direct = (error as { readonly code?: unknown }).code;
  if (typeof direct === 'string' && direct) return direct;
  const directMessage = error instanceof Error ? error.message : undefined;
  const directMatch = directMessage?.match(/\b((?:UND_)?ERR_[A-Z0-9_]+)\b/u)?.[1];
  if (directMatch) return directMatch;
  const cause = (error as { readonly cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const nested = (cause as { readonly code?: unknown }).code;
  if (typeof nested === 'string' && nested) return nested;
  const causeMessage = cause instanceof Error ? cause.message : undefined;
  return causeMessage?.match(/\b((?:UND_)?ERR_[A-Z0-9_]+)\b/u)?.[1];
}

function isLocalEndpoint(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
}

function transportErrorMessage(url: URL, code: string | undefined, aborted: boolean): string {
  if (aborted) return 'AI 请求已取消。';
  const suffix = code ? `（${code}）` : '';
  if (isLocalEndpoint(url)) {
    return `无法完成本地 AI 请求：与 ${url.origin} 的连接中断${suffix}。请确认 LM Studio 或 Ollama 仍在运行，然后重试。`;
  }
  return `AI 服务请求失败：无法连接 ${url.origin}${suffix}。请检查服务地址与网络后重试。`;
}

function safeProviderErrorMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as { readonly error?: unknown; readonly message?: unknown };
  const nested = typeof record.error === 'object' && record.error !== null
    ? (record.error as { readonly message?: unknown }).message
    : undefined;
  const message = typeof nested === 'string'
    ? nested
    : typeof record.message === 'string'
      ? record.message
      : undefined;
  const sanitized = message
    ? [...message]
      .map((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 32 || codePoint === 127 ? ' ' : character;
      })
      .join('')
      .replaceAll(/\s+/gu, ' ')
      .trim()
    : undefined;
  return sanitized ? sanitized.slice(0, 500) : undefined;
}

async function readProviderErrorMessage(response: Response): Promise<string | undefined> {
  try {
    return safeProviderErrorMessage(JSON.parse(await response.text()) as unknown);
  } catch {
    return undefined;
  }
}

async function readProviderJson(response: Response): Promise<unknown> {
  let source: string;
  try {
    source = await response.text();
  } catch (error: unknown) {
    const code = transportErrorCode(error);
    throw new AIProviderError(
      `AI 服务响应在传输完成前中断${code ? `（${code}）` : ''}。请重试；如果持续发生，请更换模型或检查网络。`,
      response.status,
      code ?? 'INCOMPLETE_PROVIDER_RESPONSE',
      { cause: error },
    );
  }
  const normalized = source.replace(/^\uFEFF/u, '').trim();
  if (!normalized) {
    throw new AIProviderError(
      'AI 服务返回了空响应。请重试；如果持续发生，请更换模型。',
      response.status,
      'EMPTY_PROVIDER_RESPONSE',
    );
  }
  try {
    return JSON.parse(normalized) as unknown;
  } catch (error: unknown) {
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    const message = mediaType === 'text/event-stream' || normalized.startsWith('data:')
      ? 'AI 服务意外返回了流式事件，但 Oldfolio 已请求非流式 JSON。请重试；如果持续发生，请更换模型。'
      : mediaType === 'text/html' || normalized.startsWith('<!DOCTYPE') || normalized.startsWith('<html')
        ? 'AI 服务返回了网页而不是 API JSON，可能遇到网关或防护页面。请稍后重试。'
        : 'AI 服务返回的内容不是完整有效的 JSON，可能是响应传输中断。请重试；如果持续发生，请更换模型。';
    throw new AIProviderError(message, response.status, 'INVALID_PROVIDER_RESPONSE', { cause: error });
  }
}

function contextWindowErrorDetails(message: string | undefined): {
  readonly requestTokens: number;
  readonly availableContextTokens: number;
} | undefined {
  const match = message?.match(
    /request\s*\((\d+)\s*tokens?\)\s*exceeds\s*the\s*available\s*context\s*size\s*\((\d+)\s*tokens?\)/iu,
  );
  if (!match) return undefined;
  const requestTokens = Number(match[1]);
  const availableContextTokens = Number(match[2]);
  if (!Number.isSafeInteger(requestTokens) || !Number.isSafeInteger(availableContextTokens)) return undefined;
  return { requestTokens, availableContextTokens };
}

abstract class HttpAIProvider implements AIProvider {
  abstract readonly id: string;
  abstract readonly displayName: string;
  readonly capabilities: readonly AICapability[] = ['chat'];
  protected readonly options: ProviderOptions;

  protected constructor(options: ProviderOptions = {}) {
    this.options = {
      ...options,
      defaultHeaders: Object.freeze({ ...(options.defaultHeaders ?? {}) }),
    };
  }

  abstract listModels(
    config: AIProviderConfig,
    context?: AIInvocationContext,
  ): Promise<readonly AIModelDescriptor[]>;

  abstract complete(
    config: AIProviderConfig,
    request: AICompletionRequest,
    context?: AIInvocationContext,
  ): Promise<AICompletion>;

  protected endpoint(config: AIProviderConfig, defaultEndpoint?: string): URL {
    if (config.providerId !== this.id) {
      throw new AIProviderError(`Provider configuration "${config.providerId}" cannot be used with "${this.id}".`);
    }
    return validateAIEndpoint(config.endpoint || defaultEndpoint || '', this.options.endpointPolicy);
  }

  protected async request(
    url: URL,
    init: Omit<RequestInit, 'headers'> & { readonly headers?: HeadersInit },
    config: AIProviderConfig,
    context?: AIInvocationContext,
  ): Promise<Response> {
    const headers = new Headers(this.options.defaultHeaders);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (config.secretRef) {
      if (!context) throw new AIProviderError('A secret resolver is required for the configured keychain reference.');
      const secret = await context.resolveSecret(config.secretRef);
      if (!secret) throw new AIProviderError(`No secret is available for keychain reference "${config.secretRef}".`);
      headers.set('authorization', `Bearer ${secret}`);
    }
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(url, {
        ...init,
        headers,
        redirect: 'manual',
        ...(context?.signal === undefined ? {} : { signal: context.signal }),
      });
    } catch (error: unknown) {
      if (error instanceof AIProviderError) throw error;
      const code = transportErrorCode(error);
      const aborted = context?.signal?.aborted === true
        || (error instanceof Error && error.name === 'AbortError');
      throw new AIProviderError(
        transportErrorMessage(url, code, aborted),
        undefined,
        code,
        { cause: error },
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new AIProviderError('AI endpoint redirects are disabled to prevent credential disclosure.', response.status);
    }
    if (!response.ok) {
      const detail = await readProviderErrorMessage(response);
      const contextWindow = contextWindowErrorDetails(detail);
      const insufficientCredits = response.status === 402;
      throw new AIProviderError(
        insufficientCredits
          ? 'AI 服务账户余额不足，或当前模型不属于免费额度。请充值后重试，或切换到服务商提供的免费模型。'
          : `AI provider request failed with status ${response.status}${detail ? `: ${detail}` : '.'}`,
        response.status,
        insufficientCredits
          ? 'INSUFFICIENT_CREDITS'
          : contextWindow
            ? 'CONTEXT_WINDOW_EXCEEDED'
            : undefined,
        contextWindow,
      );
    }
    return response;
  }

  protected async requestJson(
    url: URL,
    init: Omit<RequestInit, 'headers'> & { readonly headers?: HeadersInit },
    config: AIProviderConfig,
    context?: AIInvocationContext,
  ): Promise<unknown> {
    return readProviderJson(await this.request(url, init, config, context));
  }
}

const finishReason = (value: unknown): AICompletion['finishReason'] => {
  switch (value) {
    case 'stop':
    case 'length':
    case 'content_filter':
    case 'error':
      return value;
    default:
      return 'unknown';
  }
};

interface OpenAIResponse {
  readonly model?: unknown;
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown; readonly reasoning_content?: unknown; readonly reasoning?: unknown };
    readonly finish_reason?: unknown;
  }[];
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown };
}

interface OpenAIStreamChunk {
  readonly model?: unknown;
  readonly choices?: readonly {
    readonly delta?: { readonly content?: unknown; readonly reasoning_content?: unknown; readonly reasoning?: unknown };
    readonly message?: { readonly content?: unknown; readonly reasoning_content?: unknown; readonly reasoning?: unknown };
    readonly finish_reason?: unknown;
  }[];
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown };
  readonly error?: unknown;
}

async function readOpenAIEventStream(response: Response, maxOutputTokens: number | undefined): Promise<OpenAIResponse> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new AIProviderError('AI 服务没有返回可读取的流。请重试或更换模型。', response.status, 'EMPTY_PROVIDER_STREAM');
  }
  const decoder = new TextDecoder();
  const maximumCharacters = Math.min(32 * 1024 * 1024, Math.max(1_048_576, (maxOutputTokens ?? 32_768) * 16));
  let buffer = '';
  let content = '';
  let model: string | undefined;
  let streamFinishReason: unknown;
  let usage: OpenAIResponse['usage'];
  let reasoningSeen = false;
  let doneSeen = false;

  const consumeData = (data: string): void => {
    const normalized = data.trim();
    if (!normalized) return;
    if (normalized === '[DONE]') {
      doneSeen = true;
      return;
    }
    let chunk: OpenAIStreamChunk;
    try {
      chunk = JSON.parse(normalized) as OpenAIStreamChunk;
    } catch (error: unknown) {
      throw new AIProviderError(
        'AI 服务返回了损坏的流式事件。请重试；如果持续发生，请更换模型。',
        response.status,
        'INVALID_PROVIDER_STREAM',
        { cause: error },
      );
    }
    if (chunk.error !== undefined) {
      const detail = safeProviderErrorMessage(chunk);
      throw new AIProviderError(
        detail ? `AI 服务在生成过程中失败：${detail}` : 'AI 服务在生成过程中失败。请重试或更换模型。',
        response.status,
        'PROVIDER_STREAM_ERROR',
      );
    }
    if (typeof chunk.model === 'string') model = chunk.model;
    if (chunk.usage !== undefined) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    const deltaContent = choice?.delta?.content;
    const messageContent = choice?.message?.content;
    const nextContent = typeof deltaContent === 'string'
      ? deltaContent
      : typeof messageContent === 'string'
        ? messageContent
        : '';
    if (nextContent) {
      content += nextContent;
      if (content.length > maximumCharacters) {
        throw new AIProviderError('AI 服务的流式输出超过安全上限，已停止接收。', response.status, 'PROVIDER_STREAM_TOO_LARGE');
      }
    }
    reasoningSeen ||= typeof choice?.delta?.reasoning_content === 'string'
      || typeof choice?.delta?.reasoning === 'string'
      || typeof choice?.message?.reasoning_content === 'string'
      || typeof choice?.message?.reasoning === 'string';
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      streamFinishReason = choice.finish_reason;
    }
  };

  try {
    while (!doneSeen) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:')) consumeData(line.slice(5));
      }
      if (done) {
        if (buffer.startsWith('data:')) consumeData(buffer.slice(5));
        break;
      }
    }
  } catch (error: unknown) {
    if (error instanceof AIProviderError) throw error;
    const code = transportErrorCode(error);
    throw new AIProviderError(
      `AI 服务的流式响应在完成前中断${code ? `（${code}）` : ''}。未完成内容已丢弃，请重试或更换模型。`,
      response.status,
      code ?? 'INCOMPLETE_PROVIDER_STREAM',
      { cause: error },
    );
  } finally {
    reader.releaseLock();
  }
  if (!doneSeen) {
    throw new AIProviderError(
      'AI 服务的流式响应没有正常结束。未完成内容已丢弃，请重试或更换模型。',
      response.status,
      'INCOMPLETE_PROVIDER_STREAM',
    );
  }
  return {
    ...(model === undefined ? {} : { model }),
    choices: [{
      message: {
        content,
        ...(reasoningSeen ? { reasoning_content: 'present' } : {}),
      },
      finish_reason: streamFinishReason,
    }],
    ...(usage === undefined ? {} : { usage }),
  };
}

function supportsOnlyJsonTranscription(model: string): boolean {
  return /^gpt-4o(?:-mini)?-transcribe(?:-|$)/iu.test(model.trim());
}

function discoveredContextWindow(...values: readonly unknown[]): number | undefined {
  return values.find((value): value is number => (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 4_096 && value <= 10_000_000
  ));
}

export class OpenAICompatibleProvider extends HttpAIProvider {
  readonly id = 'openai-compatible';
  readonly displayName = 'OpenAI-compatible';
  override readonly capabilities = ['chat', 'transcription'] as const;

  constructor(options: ProviderOptions = {}) {
    super(options);
  }

  async listModels(config: AIProviderConfig, context?: AIInvocationContext): Promise<readonly AIModelDescriptor[]> {
    const response = (await this.requestJson(
      resolveEndpoint(this.endpoint(config), 'models'),
      { method: 'GET' },
      config,
      context,
    )) as { readonly data?: readonly {
      readonly id?: unknown;
      readonly name?: unknown;
      readonly context_window?: unknown;
      readonly context_length?: unknown;
      readonly max_context_length?: unknown;
    }[] };
    return (response.data ?? [])
      .filter((item): item is typeof item & { readonly id: string } => typeof item.id === 'string')
      .map((item) => {
        const contextWindow = discoveredContextWindow(
          item.context_window,
          item.context_length,
          item.max_context_length,
        );
        return {
          id: item.id,
          displayName: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.id,
          capabilities: ['chat'],
          local: false,
          ...(contextWindow === undefined ? {} : { contextWindow }),
        };
      });
  }

  async complete(
    config: AIProviderConfig,
    request: AICompletionRequest,
    context?: AIInvocationContext,
  ): Promise<AICompletion> {
    const reasoningMode = request.reasoningMode ?? this.options.defaultReasoningMode ?? 'provider-default';
    const reasoningBody: Readonly<Record<string, unknown>> = this.options.reasoningDialect === 'qwen' && reasoningMode !== 'provider-default'
      ? { enable_thinking: reasoningMode === 'enabled' }
      : this.options.reasoningDialect === 'deepseek' && reasoningMode !== 'provider-default'
        ? { thinking: { type: reasoningMode } }
        : this.options.reasoningDialect === 'openrouter' && reasoningMode !== 'provider-default'
          ? {
              reasoning: reasoningMode === 'enabled'
                ? { enabled: true }
                : { effort: 'none' },
            }
          : {};
    const stream = this.options.streamChatCompletions === true;
    const url = resolveEndpoint(this.endpoint(config), 'chat/completions');
    const invoke = async (invocationReasoningBody: Readonly<Record<string, unknown>>): Promise<OpenAIResponse> => {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream,
          ...invocationReasoningBody,
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
          ...(request.responseSchema === undefined
            ? request.responseFormat === 'json'
              ? { response_format: { type: 'json_object' } }
              : {}
            : this.options.structuredOutputMode === 'json-object'
              ? { response_format: { type: 'json_object' } }
              : {
                response_format: {
                  type: 'json_schema',
                  json_schema: { name: 'oldfolio_response', schema: request.responseSchema, strict: true },
                },
              }),
        }),
      } satisfies Omit<RequestInit, 'headers'> & { readonly headers?: HeadersInit };
      return stream
        ? readOpenAIEventStream(await this.request(url, init, config, context), request.maxOutputTokens)
        : await this.requestJson(url, init, config, context) as OpenAIResponse;
    };
    let response: OpenAIResponse;
    try {
      response = await invoke(reasoningBody);
    } catch (error: unknown) {
      const mandatoryReasoningRejected = this.options.reasoningDialect === 'openrouter'
        && reasoningMode === 'disabled'
        && error instanceof AIProviderError
        && error.status === 400
        && /reasoning.*(?:mandatory|required).*cannot be disabled/iu.test(error.message);
      if (!mandatoryReasoningRejected) throw error;
      response = await invoke({});
    }
    const choice = response.choices?.[0];
    if (choice?.message?.content === '' && choice.finish_reason === 'length'
      && (typeof choice.message.reasoning_content === 'string' || typeof choice.message.reasoning === 'string')) {
      throw new AIProviderError(
        '模型把输出额度全部用于思考，没有生成最终摘要。请关闭该模型的思考模式，或提高模型上下文窗口后重试。',
        undefined,
        'REASONING_OUTPUT_EXHAUSTED',
      );
    }
    if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) {
      throw new AIProviderError('AI provider response did not contain text content.');
    }
    return {
      content: choice.message.content,
      model: typeof response.model === 'string' ? response.model : request.model,
      finishReason: finishReason(choice.finish_reason),
      ...(response.usage === undefined
        ? {}
        : {
            usage: {
              ...(typeof response.usage.prompt_tokens === 'number'
                ? { inputTokens: response.usage.prompt_tokens }
                : {}),
              ...(typeof response.usage.completion_tokens === 'number'
                ? { outputTokens: response.usage.completion_tokens }
                : {}),
            },
          }),
    };
  }

  async transcribe(
    config: AIProviderConfig,
    request: AITranscriptionRequest,
    context?: AIInvocationContext,
  ): Promise<AITranscriptionResult> {
    if (!this.options.readMedia) throw new AIProviderError('在线转录缺少受控媒体读取器。');
    const media = await this.options.readMedia(request.mediaUri, context?.signal);
    if (!media.fileName.trim() || !media.mimeType.trim() || media.bytes.byteLength === 0) {
      throw new AIProviderError('在线转录媒体无效。');
    }
    const form = new FormData();
    const bytes = new Uint8Array(media.bytes).buffer;
    form.append('file', new Blob([bytes], { type: media.mimeType }), media.fileName);
    form.append('model', request.model);
    if (supportsOnlyJsonTranscription(request.model)) {
      form.append('response_format', 'json');
    } else {
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
    }
    if (request.language) form.append('language', request.language);
    if (request.prompt) form.append('prompt', request.prompt);
    const response = (await this.requestJson(
      resolveEndpoint(this.endpoint(config), 'audio/transcriptions'),
      { method: 'POST', body: form },
      config,
      context,
    )) as {
      readonly text?: unknown;
      readonly language?: unknown;
      readonly segments?: readonly {
        readonly start?: unknown;
        readonly end?: unknown;
        readonly text?: unknown;
      }[];
      readonly usage?: {
        readonly input_tokens?: unknown;
        readonly output_tokens?: unknown;
      };
    };
    if (typeof response.text !== 'string' || !response.text.trim()) {
      throw new AIProviderError('在线转录响应没有包含文案。');
    }
    const segments = (response.segments ?? []).flatMap((segment) => {
      if (
        typeof segment.start !== 'number' || !Number.isFinite(segment.start) || segment.start < 0
        || typeof segment.end !== 'number' || !Number.isFinite(segment.end) || segment.end < segment.start
        || typeof segment.text !== 'string' || !segment.text.trim()
      ) return [];
      return [{
        startMs: Math.round(segment.start * 1_000),
        endMs: Math.max(Math.round(segment.end * 1_000), Math.round(segment.start * 1_000) + 1),
        text: segment.text.trim(),
      }];
    });
    return {
      text: response.text.trim(),
      segments: segments.length > 0
        ? segments
        : [{ startMs: 0, endMs: Math.max(1, request.durationMs ?? 1), text: response.text.trim() }],
      ...(typeof response.language === 'string' && response.language.trim()
        ? { language: response.language.trim() }
        : request.language ? { language: request.language } : {}),
      ...(response.usage === undefined ? {} : {
        usage: {
          ...(typeof response.usage.input_tokens === 'number' ? { inputTokens: response.usage.input_tokens } : {}),
          ...(typeof response.usage.output_tokens === 'number' ? { outputTokens: response.usage.output_tokens } : {}),
        },
      }),
    };
  }
}

interface LMStudioNativeResponse {
  readonly model_instance_id?: unknown;
  readonly output?: readonly { readonly type?: unknown; readonly content?: unknown }[];
  readonly stats?: {
    readonly input_tokens?: unknown;
    readonly total_output_tokens?: unknown;
    readonly reasoning_output_tokens?: unknown;
  };
}

/**
 * Uses LM Studio's native v1 API so reasoning can be disabled reliably for
 * schema-bound knowledge maintenance. The persisted provider id remains
 * openai-compatible for backward compatibility with existing device config.
 */
export class LMStudioProvider extends HttpAIProvider {
  readonly id = 'openai-compatible';
  readonly displayName = 'LM Studio';

  constructor(options: ProviderOptions = {}) {
    super({
      ...options,
      endpointPolicy: { allowLocalhostHttp: true, ...(options.endpointPolicy ?? {}) },
    });
  }

  private nativeEndpoint(config: AIProviderConfig, path: string): URL {
    const configured = this.endpoint(config);
    return new URL(`/api/v1/${path}`, configured);
  }

  async listModels(config: AIProviderConfig, context?: AIInvocationContext): Promise<readonly AIModelDescriptor[]> {
    const response = (await this.requestJson(
      this.nativeEndpoint(config, 'models'),
      { method: 'GET' },
      config,
      context,
    )) as {
      readonly models?: readonly {
        readonly type?: unknown;
        readonly key?: unknown;
        readonly display_name?: unknown;
        readonly max_context_length?: unknown;
        readonly loaded_instances?: readonly {
          readonly config?: { readonly context_length?: unknown };
        }[];
      }[];
    };
    return (response.models ?? [])
      .filter((item): item is typeof item & { readonly type: 'llm'; readonly key: string } =>
        item.type === 'llm' && typeof item.key === 'string')
      .map((item) => {
        const loadedContextWindows = (item.loaded_instances ?? [])
          .map((instance) => discoveredContextWindow(instance.config?.context_length))
          .filter((value): value is number => value !== undefined);
        const contextWindow = loadedContextWindows.length > 0
          ? Math.min(...loadedContextWindows)
          : discoveredContextWindow(item.max_context_length);
        return {
          id: item.key,
          displayName: typeof item.display_name === 'string' ? item.display_name : item.key,
          capabilities: ['chat'],
          local: true,
          ...(contextWindow === undefined ? {} : { contextWindow }),
        };
      });
  }

  async complete(
    config: AIProviderConfig,
    request: AICompletionRequest,
    context?: AIInvocationContext,
  ): Promise<AICompletion> {
    const systemMessages = request.messages.filter((message) => message.role === 'system').map((message) => message.content);
    const inputMessages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => `${message.role.toUpperCase()}_MESSAGE\n${message.content}`)
      .join('\n\n');
    const formatInstruction = request.responseSchema === undefined
      ? request.responseFormat === 'json'
        ? 'Return only one valid JSON object, without Markdown fences or commentary.'
        : ''
      : `Return only one valid JSON object matching this JSON Schema, without Markdown fences or commentary:\n${JSON.stringify(request.responseSchema)}`;
    const baseBody = {
      model: request.model,
      input: inputMessages,
      system_prompt: [...systemMessages, formatInstruction].filter(Boolean).join('\n\n'),
      store: false,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
    };
    const invoke = (reasoning: boolean) => this.requestJson(
      this.nativeEndpoint(config, 'chat'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...baseBody, ...(reasoning ? { reasoning: 'off' } : {}) }),
      },
      config,
      context,
    ) as Promise<LMStudioNativeResponse>;

    let response: LMStudioNativeResponse;
    try {
      response = await invoke(true);
    } catch (error: unknown) {
      if (!(error instanceof AIProviderError) || error.status !== 400 || !/reasoning/iu.test(error.message)) throw error;
      response = await invoke(false);
    }
    const content = response.output
      ?.filter((item) => item.type === 'message' && typeof item.content === 'string')
      .map((item) => item.content as string)
      .join('\n')
      .trim();
    if (!content) {
      const reasoningOnly = response.output?.some((item) => item.type === 'reasoning' && typeof item.content === 'string');
      throw new AIProviderError(reasoningOnly
        ? 'LM Studio returned reasoning but no final answer. Disable model thinking or increase its output limit.'
        : 'LM Studio response did not contain text content.');
    }
    return {
      content,
      model: typeof response.model_instance_id === 'string' ? response.model_instance_id : request.model,
      finishReason: 'stop',
      ...(response.stats === undefined ? {} : {
        usage: {
          ...(typeof response.stats.input_tokens === 'number' ? { inputTokens: response.stats.input_tokens } : {}),
          ...(typeof response.stats.total_output_tokens === 'number'
            ? { outputTokens: response.stats.total_output_tokens }
            : {}),
        },
      }),
    };
  }

}

interface OllamaResponse {
  readonly model?: unknown;
  readonly message?: { readonly content?: unknown };
  readonly done_reason?: unknown;
  readonly prompt_eval_count?: unknown;
  readonly eval_count?: unknown;
}

export class OllamaProvider extends HttpAIProvider {
  readonly id = 'ollama';
  readonly displayName = 'Ollama';

  constructor(options: ProviderOptions = {}) {
    super({
      ...options,
      endpointPolicy: { allowLocalhostHttp: true, ...(options.endpointPolicy ?? {}) },
    });
  }

  private ollamaEndpoint(config: AIProviderConfig): URL {
    return this.endpoint(config, 'http://127.0.0.1:11434/api/');
  }

  async listModels(config: AIProviderConfig, context?: AIInvocationContext): Promise<readonly AIModelDescriptor[]> {
    const response = (await this.requestJson(
      resolveEndpoint(this.ollamaEndpoint(config), 'tags'),
      { method: 'GET' },
      config,
      context,
    )) as { readonly models?: readonly { readonly name?: unknown }[] };
    return (response.models ?? [])
      .filter((item): item is { readonly name: string } => typeof item.name === 'string')
      .map((item) => ({ id: item.name, displayName: item.name, capabilities: ['chat'], local: true }));
  }

  async complete(
    config: AIProviderConfig,
    request: AICompletionRequest,
    context?: AIInvocationContext,
  ): Promise<AICompletion> {
    const response = (await this.requestJson(
      resolveEndpoint(this.ollamaEndpoint(config), 'chat'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: false,
          ...(request.temperature === undefined ? {} : { options: { temperature: request.temperature } }),
          ...(request.responseSchema === undefined
            ? request.responseFormat === 'json'
              ? { format: 'json' }
              : {}
            : { format: request.responseSchema }),
        }),
      },
      config,
      context,
    )) as OllamaResponse;
    if (typeof response.message?.content !== 'string') {
      throw new AIProviderError('Ollama response did not contain text content.');
    }
    return {
      content: response.message.content,
      model: typeof response.model === 'string' ? response.model : request.model,
      finishReason: finishReason(response.done_reason),
      usage: {
        ...(typeof response.prompt_eval_count === 'number' ? { inputTokens: response.prompt_eval_count } : {}),
        ...(typeof response.eval_count === 'number' ? { outputTokens: response.eval_count } : {}),
      },
    };
  }
}
