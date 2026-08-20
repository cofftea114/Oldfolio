import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { OpenAICompatibleProvider, validateAIEndpoint } from '@oldfolio/ai';
import type { AIInvocationContext, AIProvider, AIProviderConfig } from '@oldfolio/domain';

import { normalizeAIContextWindow } from './ai-device-config.js';

const ONLINE_SECRET_REF = 'session:online-openai-compatible';

export type OnlineSummaryPreset = 'custom' | 'openai' | 'deepseek' | 'kimi' | 'glm' | 'minimax' | 'grok' | 'qwen' | 'gemini';

export const ONLINE_SUMMARY_PRESETS: Readonly<Record<Exclude<OnlineSummaryPreset, 'custom'>, {
  readonly endpoint: string;
  readonly model: string;
  readonly label: string;
}>> = {
  openai: { endpoint: 'https://api.openai.com/v1/', model: 'gpt-5-mini', label: 'OpenAI' },
  deepseek: { endpoint: 'https://api.deepseek.com/v1/', model: 'deepseek-chat', label: 'DeepSeek' },
  kimi: { endpoint: 'https://api.moonshot.ai/v1/', model: 'kimi-k2.6', label: 'Kimi' },
  glm: { endpoint: 'https://open.bigmodel.cn/api/paas/v4/', model: 'glm-5.2', label: 'GLM' },
  minimax: { endpoint: 'https://api.minimaxi.com/v1/', model: 'MiniMax-M2.7', label: 'MiniMax' },
  grok: { endpoint: 'https://api.x.ai/v1/', model: 'grok-4.5', label: 'Grok' },
  qwen: { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/', model: 'qwen3.7-plus', label: 'Qwen' },
  gemini: { endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-3.6-flash', label: 'Gemini' },
};

export interface OnlineAIConfig {
  readonly version: 1;
  readonly preset: OnlineSummaryPreset;
  readonly endpoint: string;
  readonly confirmedHost: string;
  readonly chatModel: string;
  readonly transcriptionModel: string;
  readonly contextWindow: number;
  readonly secretRef: typeof ONLINE_SECRET_REF;
}

export interface OnlineAISettings extends OnlineAIConfig {
  readonly configured: boolean;
  readonly keyAvailable: boolean;
}

export interface ConfigureOnlineAIInput {
  readonly preset?: OnlineSummaryPreset;
  readonly endpoint: string;
  readonly chatModel: string;
  readonly transcriptionModel?: string;
  readonly contextWindow?: number;
  readonly apiKey: string;
  readonly hostConfirmed: boolean;
}

export interface OnlineAIRuntime {
  readonly provider: AIProvider;
  readonly config: AIProviderConfig;
  readonly transcriptionModel: string;
  readonly context: AIInvocationContext;
  readonly host: string;
}

export type OnlineMediaReader = (
  uri: string,
  signal?: AbortSignal,
) => Promise<{ readonly bytes: Uint8Array; readonly fileName: string; readonly mimeType: string }>;

const DEFAULT_CONFIG: OnlineAIConfig = {
  version: 1,
  preset: 'openai',
  endpoint: 'https://api.openai.com/v1/',
  confirmedHost: 'api.openai.com',
  chatModel: '',
  transcriptionModel: '',
  contextWindow: 128_000,
  secretRef: ONLINE_SECRET_REF,
};

function boundedModel(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || normalized.includes('\0')) throw new Error(`${label}无效。`);
  return normalized;
}

export function normalizeOnlineAIEndpoint(value: string, hostConfirmed: boolean): URL {
  if (!hostConfirmed) throw new Error('请先确认在线 AI 服务域名。');
  if (!value.trim() || value.length > 2_048 || value.includes('\0')) throw new Error('在线 AI 地址无效。');
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('在线 AI 地址无效。');
  }
  if (parsed.search) throw new Error('在线 AI 地址不能包含查询参数。');
  const url = validateAIEndpoint(parsed, { confirmedHosts: [parsed.hostname] });
  if (url.pathname === '/') url.pathname = '/v1/';
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url;
}

function parseConfig(source: string): OnlineAIConfig {
  const value = JSON.parse(source) as Partial<OnlineAIConfig>;
  if (
    value.version !== 1 || typeof value.endpoint !== 'string' || typeof value.confirmedHost !== 'string'
    || typeof value.chatModel !== 'string' || typeof value.transcriptionModel !== 'string'
    || value.secretRef !== ONLINE_SECRET_REF
  ) throw new Error('在线 AI 设备配置无效。');
  const endpoint = normalizeOnlineAIEndpoint(value.endpoint, true);
  const preset = typeof value.preset === 'string' && ['custom', 'openai', 'deepseek', 'kimi', 'glm', 'minimax', 'grok', 'qwen', 'gemini'].includes(value.preset)
    ? value.preset
    : Object.entries(ONLINE_SUMMARY_PRESETS).find(([, item]) => new URL(item.endpoint).hostname === endpoint.hostname)?.[0] as OnlineSummaryPreset | undefined
      ?? 'custom';
  if (endpoint.hostname.toLowerCase() !== value.confirmedHost.toLowerCase()) {
    throw new Error('在线 AI 配置的已确认域名不匹配。');
  }
  return {
    version: 1,
    preset,
    endpoint: endpoint.href,
    confirmedHost: endpoint.hostname.toLowerCase(),
    chatModel: value.chatModel.trim(),
    transcriptionModel: value.transcriptionModel.trim(),
    contextWindow: normalizeAIContextWindow(value.contextWindow, 128_000),
    secretRef: ONLINE_SECRET_REF,
  };
}

export class OnlineAIConfigStore {
  constructor(readonly filePath: string) {}

  async load(): Promise<OnlineAIConfig> {
    try {
      return parseConfig(await readFile(this.filePath, 'utf8'));
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return DEFAULT_CONFIG;
      throw error;
    }
  }

  async save(config: OnlineAIConfig): Promise<OnlineAIConfig> {
    const validated = parseConfig(JSON.stringify(config));
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
    await rename(temporary, this.filePath);
    return validated;
  }
}

export class SessionSecretStore {
  readonly #secrets = new Map<string, string>();

  set(reference: string, secret: string): void {
    if (!reference.trim() || !secret.trim()) throw new Error('API Key 不能为空。');
    this.#secrets.set(reference, secret.trim());
  }

  get(reference: string): string | undefined {
    return this.#secrets.get(reference);
  }

  delete(reference: string): void {
    this.#secrets.delete(reference);
  }

  clear(): void {
    this.#secrets.clear();
  }
}

export class OnlineAIService {
  constructor(
    private readonly configStore: OnlineAIConfigStore,
    private readonly secrets: SessionSecretStore,
    private readonly fetchImplementation: typeof fetch,
    private readonly readMedia: OnlineMediaReader,
  ) {}

  async settings(): Promise<OnlineAISettings> {
    const config = await this.configStore.load();
    return {
      ...config,
      configured: Boolean(config.chatModel),
      keyAvailable: Boolean(this.secrets.get(config.secretRef)),
    };
  }

  async probe(endpoint: string, apiKey: string, hostConfirmed: boolean): Promise<readonly {
    id: string;
    displayName: string;
    contextWindow?: number;
  }[]> {
    const url = normalizeOnlineAIEndpoint(endpoint, hostConfirmed);
    const provider = this.provider(url, 'custom');
    this.secrets.set(ONLINE_SECRET_REF, apiKey);
    try {
      const models = await provider.listModels({
        providerId: 'openai-compatible', endpoint: url.href, model: '', secretRef: ONLINE_SECRET_REF,
      }, this.context());
      return models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      }));
    } catch (error) {
      this.secrets.delete(ONLINE_SECRET_REF);
      throw error;
    }
  }

  async configure(input: ConfigureOnlineAIInput): Promise<OnlineAISettings> {
    const endpoint = normalizeOnlineAIEndpoint(input.endpoint, input.hostConfirmed);
    const transcriptionModel = input.transcriptionModel?.trim()
      ? boundedModel(input.transcriptionModel, '在线转录模型')
      : (await this.configStore.load()).transcriptionModel;
    this.secrets.set(ONLINE_SECRET_REF, input.apiKey);
    const config: OnlineAIConfig = {
      version: 1,
      preset: input.preset ?? 'custom',
      endpoint: endpoint.href,
      confirmedHost: endpoint.hostname.toLowerCase(),
      chatModel: boundedModel(input.chatModel, '在线总结模型'),
      transcriptionModel,
      contextWindow: normalizeAIContextWindow(input.contextWindow, 128_000),
      secretRef: ONLINE_SECRET_REF,
    };
    try {
      await this.configStore.save(config);
      return this.settings();
    } catch (error) {
      this.secrets.delete(ONLINE_SECRET_REF);
      throw error;
    }
  }

  async summaryRuntime(signal?: AbortSignal): Promise<OnlineAIRuntime> {
    const config = await this.configStore.load();
    if (!config.chatModel) throw new Error('请先配置在线摘要服务与模型。');
    if (!this.secrets.get(config.secretRef)) throw new Error('在线 API Key 只保留在当前会话，请重新输入并连接。');
    const endpoint = normalizeOnlineAIEndpoint(config.endpoint, true);
    return {
      provider: this.provider(endpoint, config.preset),
      config: {
        providerId: 'openai-compatible', endpoint: endpoint.href, model: config.chatModel,
        contextWindow: normalizeAIContextWindow(config.contextWindow, 128_000), secretRef: config.secretRef,
      },
      transcriptionModel: config.transcriptionModel,
      context: this.context(signal),
      host: endpoint.hostname,
    };
  }

  async transcriptionRuntime(model: string, signal?: AbortSignal): Promise<OnlineAIRuntime> {
    const runtime = await this.summaryRuntime(signal);
    return {
      ...runtime,
      transcriptionModel: boundedModel(model, '在线转录模型'),
      config: { ...runtime.config, model: boundedModel(model, '在线转录模型') },
    };
  }

  runtime(signal?: AbortSignal): Promise<OnlineAIRuntime> {
    return this.summaryRuntime(signal);
  }

  clearSessionKey(): void {
    this.secrets.clear();
  }

  private provider(endpoint: URL, preset: OnlineSummaryPreset): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({
      endpointPolicy: { confirmedHosts: [endpoint.hostname] },
      fetch: this.fetchImplementation,
      readMedia: this.readMedia,
      structuredOutputMode: preset === 'openai' || preset === 'grok' || preset === 'gemini' || preset === 'custom' ? 'json-schema' : 'json-object',
      ...(preset === 'qwen'
        ? { reasoningDialect: 'qwen' as const, defaultReasoningMode: 'disabled' as const }
        : preset === 'deepseek'
          ? { reasoningDialect: 'deepseek' as const, defaultReasoningMode: 'disabled' as const }
          : {}),
    });
  }

  private context(signal?: AbortSignal): AIInvocationContext {
    return {
      resolveSecret: (reference) => Promise.resolve(this.secrets.get(reference)),
      ...(signal ? { signal } : {}),
    };
  }
}
