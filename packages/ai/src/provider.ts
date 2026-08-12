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
  ) {
    super(message);
    this.name = 'AIProviderError';
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
    const response = await (this.options.fetch ?? globalThis.fetch)(url, {
      ...init,
      headers,
      redirect: 'manual',
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new AIProviderError('AI endpoint redirects are disabled to prevent credential disclosure.', response.status);
    }
    if (!response.ok) {
      throw new AIProviderError(`AI provider request failed with status ${response.status}.`, response.status);
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
    readonly message?: { readonly content?: unknown };
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
    if (typeof choice?.message?.content !== 'string') {
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
