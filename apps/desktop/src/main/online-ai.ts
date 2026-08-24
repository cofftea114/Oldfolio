import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { OpenAICompatibleProvider, validateAIEndpoint } from '@oldfolio/ai';
import type { AIInvocationContext, AIProvider, AIProviderConfig } from '@oldfolio/domain';

import { normalizeAIContextWindow } from './ai-device-config.js';
import type { SecretStore } from './device-secret-store.js';

const LEGACY_ONLINE_SECRET_REF = 'session:online-openai-compatible';

export type OnlineSummaryPreset = 'custom' | 'openai' | 'deepseek' | 'kimi' | 'glm' | 'minimax' | 'grok' | 'qwen' | 'gemini' | 'openrouter';

const ONLINE_SUMMARY_PRESET_IDS: readonly OnlineSummaryPreset[] = [
  'custom', 'openai', 'deepseek', 'kimi', 'glm', 'minimax', 'grok', 'qwen', 'gemini', 'openrouter',
];

type OnlineAISecretRef = `online-ai:${OnlineSummaryPreset}`;

function secretRefForPreset(preset: OnlineSummaryPreset): OnlineAISecretRef {
  return `online-ai:${preset}`;
}

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
  openrouter: { endpoint: 'https://openrouter.ai/api/v1/', model: 'openrouter/free', label: 'OpenRouter' },
};

export interface OnlineAIConfig {
  readonly version: 1;
  readonly preset: OnlineSummaryPreset;
  readonly endpoint: string;
  readonly confirmedHost: string;
  readonly chatModel: string;
  readonly transcriptionModel: string;
  readonly contextWindow: number;
  readonly secretRef: OnlineAISecretRef;
}

export interface OnlineAISettings extends OnlineAIConfig {
  readonly configured: boolean;
  readonly keyAvailable: boolean;
  readonly keyPersisted: boolean;
  readonly secureStorageAvailable: boolean;
  readonly keyAvailablePresets: readonly OnlineSummaryPreset[];
  readonly keyPersistedPresets: readonly OnlineSummaryPreset[];
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
  secretRef: secretRefForPreset('openai'),
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

function presetForEndpoint(endpoint: URL): OnlineSummaryPreset {
  return Object.entries(ONLINE_SUMMARY_PRESETS)
    .find(([, item]) => new URL(item.endpoint).hostname === endpoint.hostname)?.[0] as OnlineSummaryPreset | undefined
    ?? 'custom';
}

function parseConfig(source: string): OnlineAIConfig {
  const value = JSON.parse(source) as Omit<Partial<OnlineAIConfig>, 'secretRef'> & { readonly secretRef?: unknown };
  if (
    value.version !== 1 || typeof value.endpoint !== 'string' || typeof value.confirmedHost !== 'string'
    || typeof value.chatModel !== 'string' || typeof value.transcriptionModel !== 'string'
    || typeof value.secretRef !== 'string'
  ) throw new Error('在线 AI 设备配置无效。');
  const endpoint = normalizeOnlineAIEndpoint(value.endpoint, true);
  const preset = typeof value.preset === 'string' && ONLINE_SUMMARY_PRESET_IDS.includes(value.preset)
    ? value.preset
    : presetForEndpoint(endpoint);
  const expectedSecretRef = secretRefForPreset(preset);
  if (value.secretRef !== LEGACY_ONLINE_SECRET_REF && value.secretRef !== expectedSecretRef) {
    throw new Error('在线 AI 密钥引用无效。');
  }
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
    secretRef: expectedSecretRef,
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

export class SessionSecretStore implements SecretStore {
  readonly #secrets = new Map<string, string>();
  readonly persistenceAvailable = false;

  set(reference: string, secret: string): void {
    this.setSession(reference, secret);
  }

  setSession(reference: string, secret: string): void {
    if (!reference.trim() || !secret.trim()) throw new Error('API Key 不能为空。');
    this.#secrets.set(reference, secret.trim());
  }

  persist(reference: string, secret: string): Promise<boolean> {
    this.setSession(reference, secret);
    return Promise.resolve(false);
  }

  get(reference: string): string | undefined {
    return this.#secrets.get(reference);
  }

  delete(reference: string): void {
    this.deleteSession(reference);
  }

  deleteSession(reference: string): void {
    this.#secrets.delete(reference);
  }

  remove(reference: string): Promise<void> {
    this.deleteSession(reference);
    return Promise.resolve();
  }

  clearSession(): void {
    this.#secrets.clear();
  }

  isPersisted(): boolean {
    return false;
  }
}

export class OnlineAIService {
  #legacyMigrationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly configStore: OnlineAIConfigStore,
    private readonly secrets: SecretStore,
    private readonly fetchImplementation: typeof fetch,
    private readonly readMedia: OnlineMediaReader,
  ) {}

  async settings(): Promise<OnlineAISettings> {
    const config = await this.configStore.load();
    await this.migrateLegacySecret(config.secretRef);
    return {
      ...config,
      configured: Boolean(config.chatModel),
      keyAvailable: Boolean(this.secrets.get(config.secretRef)),
      keyPersisted: this.secrets.isPersisted(config.secretRef),
      secureStorageAvailable: this.secrets.persistenceAvailable,
      keyAvailablePresets: ONLINE_SUMMARY_PRESET_IDS.filter((preset) => Boolean(this.secrets.get(secretRefForPreset(preset)))),
      keyPersistedPresets: ONLINE_SUMMARY_PRESET_IDS.filter((preset) => this.secrets.isPersisted(secretRefForPreset(preset))),
    };
  }

  async probe(endpoint: string, apiKey: string, hostConfirmed: boolean): Promise<readonly {
    id: string;
    displayName: string;
    contextWindow?: number;
  }[]> {
    const url = normalizeOnlineAIEndpoint(endpoint, hostConfirmed);
    const preset = presetForEndpoint(url);
    const secretRef = secretRefForPreset(preset);
    await this.migrateLegacySecret(secretRef);
    const provider = this.provider(url, preset);
    const previousSecret = this.secrets.get(secretRef);
    if (apiKey.trim()) this.secrets.setSession(secretRef, apiKey);
    else if (!previousSecret) throw new Error('请填写在线 API Key。');
    try {
      const models = await provider.listModels({
        providerId: 'openai-compatible', endpoint: url.href, model: '', secretRef,
      }, this.context());
      return models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      }));
    } catch (error) {
      if (apiKey.trim()) {
        if (previousSecret) this.secrets.setSession(secretRef, previousSecret);
        else this.secrets.deleteSession(secretRef);
      }
      throw error;
    }
  }

  async configure(input: ConfigureOnlineAIInput): Promise<OnlineAISettings> {
    const endpoint = normalizeOnlineAIEndpoint(input.endpoint, input.hostConfirmed);
    const preset = input.preset ?? presetForEndpoint(endpoint);
    const secretRef = secretRefForPreset(preset);
    await this.migrateLegacySecret(secretRef);
    const transcriptionModel = input.transcriptionModel?.trim()
      ? boundedModel(input.transcriptionModel, '在线转录模型')
      : (await this.configStore.load()).transcriptionModel;
    const config: OnlineAIConfig = {
      version: 1,
      preset,
      endpoint: endpoint.href,
      confirmedHost: endpoint.hostname.toLowerCase(),
      chatModel: boundedModel(input.chatModel, '在线总结模型'),
      transcriptionModel,
      contextWindow: normalizeAIContextWindow(input.contextWindow, 128_000),
      secretRef,
    };
    if (!input.apiKey.trim() && !this.secrets.get(secretRef)) {
      throw new Error('请填写在线 API Key。');
    }
    await this.configStore.save(config);
    if (input.apiKey.trim()) {
      await this.secrets.persist(secretRef, input.apiKey);
    }
    return this.settings();
  }

  async summaryRuntime(signal?: AbortSignal): Promise<OnlineAIRuntime> {
    const config = await this.configStore.load();
    if (!config.chatModel) throw new Error('请先配置在线摘要服务与模型。');
    if (!this.secrets.get(config.secretRef)) throw new Error('没有可用的在线 API Key，请重新输入并保存。');
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
    const config = await this.configStore.load();
    if (config.preset === 'openrouter') {
      throw new Error(
        'OpenRouter 当前仅用于摘要、概念提取和知识库问答，不提供 Oldfolio 在线转录所需的 /audio/transcriptions 接口。请为在线转录选择其他 OpenAI-compatible 服务或腾讯云。',
      );
    }
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
    this.secrets.clearSession();
  }

  async clearSavedKey(preset?: OnlineSummaryPreset): Promise<OnlineAISettings> {
    const config = await this.configStore.load();
    const targetPreset = preset ?? config.preset;
    const secretRef = secretRefForPreset(targetPreset);
    await this.migrateLegacySecret(secretRef);
    await this.secrets.remove(secretRef);
    return this.settings();
  }

  private async migrateLegacySecret(targetReference: OnlineAISecretRef): Promise<void> {
    const migration = this.#legacyMigrationQueue.then(() => this.performLegacySecretMigration(targetReference));
    this.#legacyMigrationQueue = migration.catch(() => undefined);
    await migration;
  }

  private async performLegacySecretMigration(targetReference: OnlineAISecretRef): Promise<void> {
    const legacy = this.secrets.get(LEGACY_ONLINE_SECRET_REF);
    if (!legacy) return;
    if (!this.secrets.get(targetReference)) {
      if (this.secrets.isPersisted(LEGACY_ONLINE_SECRET_REF)) {
        try {
          await this.secrets.persist(targetReference, legacy);
        } catch {
          this.secrets.setSession(targetReference, legacy);
          return;
        }
      } else {
        this.secrets.setSession(targetReference, legacy);
      }
    }
    await this.secrets.remove(LEGACY_ONLINE_SECRET_REF);
  }

  private provider(endpoint: URL, preset: OnlineSummaryPreset): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({
      endpointPolicy: { confirmedHosts: [endpoint.hostname] },
      fetch: this.fetchImplementation,
      readMedia: this.readMedia,
      ...(preset === 'openrouter'
        ? {
            streamChatCompletions: true,
            defaultHeaders: {
              'HTTP-Referer': 'https://github.com/cofftea114/Oldfolio',
              'X-OpenRouter-Title': 'Oldfolio',
            },
          }
        : {}),
      structuredOutputMode: preset === 'openai' || preset === 'grok' || preset === 'gemini' || preset === 'custom' ? 'json-schema' : 'json-object',
      ...(preset === 'qwen'
        ? { reasoningDialect: 'qwen' as const, defaultReasoningMode: 'disabled' as const }
        : preset === 'deepseek'
          ? { reasoningDialect: 'deepseek' as const, defaultReasoningMode: 'disabled' as const }
          : preset === 'openrouter'
            ? { reasoningDialect: 'openrouter' as const, defaultReasoningMode: 'disabled' as const }
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
