import type {
  AICompletion,
  AICompletionRequest,
  AIInvocationContext,
  AIModelDescriptor,
  AIProvider,
  AIProviderConfig,
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
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AIProviderError';
  }
}

function transportErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const direct = (error as { readonly code?: unknown }).code;
  if (typeof direct === 'string' && direct) return direct;
  const cause = (error as { readonly cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const nested = (cause as { readonly code?: unknown }).code;
  return typeof nested === 'string' && nested ? nested : undefined;
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

abstract class HttpAIProvider implements AIProvider {
  abstract readonly id: string;
  abstract readonly displayName: string;
  readonly capabilities = ['chat'] as const;
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

  protected async requestJson(
    url: URL,
    init: Omit<RequestInit, 'headers'> & { readonly headers?: HeadersInit },
    config: AIProviderConfig,
    context?: AIInvocationContext,
  ): Promise<unknown> {
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
      throw new AIProviderError(
        `AI provider request failed with status ${response.status}${detail ? `: ${detail}` : '.'}`,
        response.status,
      );
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new AIProviderError('AI provider returned invalid JSON.', response.status);
    }
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

export class OpenAICompatibleProvider extends HttpAIProvider {
  readonly id = 'openai-compatible';
  readonly displayName = 'OpenAI-compatible';

  constructor(options: ProviderOptions = {}) {
    super(options);
  }

  async listModels(config: AIProviderConfig, context?: AIInvocationContext): Promise<readonly AIModelDescriptor[]> {
    const response = (await this.requestJson(
      resolveEndpoint(this.endpoint(config), 'models'),
      { method: 'GET' },
      config,
      context,
    )) as { readonly data?: readonly { readonly id?: unknown }[] };
    return (response.data ?? [])
      .filter((item): item is { readonly id: string } => typeof item.id === 'string')
      .map((item) => ({ id: item.id, displayName: item.id, capabilities: ['chat'], local: false }));
  }

  async complete(
    config: AIProviderConfig,
    request: AICompletionRequest,
    context?: AIInvocationContext,
  ): Promise<AICompletion> {
    const response = (await this.requestJson(
      resolveEndpoint(this.endpoint(config), 'chat/completions'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
          ...(request.responseSchema === undefined
            ? request.responseFormat === 'json'
              ? { response_format: { type: 'json_object' } }
              : {}
            : {
                response_format: {
                  type: 'json_schema',
                  json_schema: { name: 'oldfolio_response', schema: request.responseSchema, strict: true },
                },
              }),
        }),
      },
      config,
      context,
    )) as OpenAIResponse;
    const choice = response.choices?.[0];
    if (choice?.message?.content === '' && choice.finish_reason === 'length'
      && (typeof choice.message.reasoning_content === 'string' || typeof choice.message.reasoning === 'string')) {
      throw new AIProviderError('AI provider used the entire output limit for reasoning and returned no final answer.');
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
      }[];
    };
    return (response.models ?? [])
      .filter((item): item is { readonly type: 'llm'; readonly key: string; readonly display_name?: string } =>
        item.type === 'llm' && typeof item.key === 'string')
      .map((item) => ({
        id: item.key,
        displayName: typeof item.display_name === 'string' ? item.display_name : item.key,
        capabilities: ['chat'],
        local: true,
      }));
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
