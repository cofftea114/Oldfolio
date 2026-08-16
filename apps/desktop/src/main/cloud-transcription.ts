import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AliyunTingwuProvider, TencentCloudASRProvider } from '@oldfolio/ai';
import type { AIInvocationContext, AIProvider, AIProviderConfig } from '@oldfolio/domain';

import type { OnlineAIService, OnlineMediaReader, SessionSecretStore } from './online-ai.js';

export type CloudTranscriptionProviderId = 'openai-compatible' | 'aliyun-tingwu' | 'tencent-asr';

const ALIYUN_SECRET_REF = 'session:aliyun-tingwu';
const TENCENT_SECRET_REF = 'session:tencent-asr';

export interface CloudTranscriptionConfig {
  readonly version: 1;
  readonly providerId: CloudTranscriptionProviderId;
  readonly model: string;
  readonly region: string;
  readonly secretRef: string;
}

export interface CloudTranscriptionSettings extends CloudTranscriptionConfig {
  readonly configured: boolean;
  readonly credentialAvailable: boolean;
  readonly endpointHost: string;
  readonly inputMode: 'chunks' | 'remote-url';
}

export type ConfigureCloudTranscriptionInput =
  | { readonly providerId: 'openai-compatible'; readonly model: string }
  | {
      readonly providerId: 'aliyun-tingwu';
      readonly region: string;
      readonly sourceLanguage: string;
      readonly accessKeyId: string;
      readonly accessKeySecret: string;
      readonly appKey: string;
    }
  | {
      readonly providerId: 'tencent-asr';
      readonly region: string;
      readonly engineModelType: string;
      readonly secretId: string;
      readonly secretKey: string;
    };

export interface CloudTranscriptionRuntime {
  readonly provider: AIProvider;
  readonly config: AIProviderConfig;
  readonly context: AIInvocationContext;
  readonly transcriptionModel: string;
  readonly host: string;
  readonly inputMode: 'chunks' | 'remote-url';
}

const DEFAULT_CONFIG: CloudTranscriptionConfig = {
  version: 1,
  providerId: 'openai-compatible',
  model: 'gpt-4o-mini-transcribe',
  region: '',
  secretRef: 'session:online-openai-compatible',
};

function bounded(value: string, label: string, max = 256): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes('\0')) throw new Error(`${label}无效。`);
  return normalized;
}

function endpoint(config: CloudTranscriptionConfig): { host: string; href: string; inputMode: 'chunks' | 'remote-url' } {
  if (config.providerId === 'aliyun-tingwu') {
    const region = bounded(config.region || 'cn-beijing', '通义听悟地域', 64);
    if (!/^cn-[a-z0-9-]+$/u.test(region)) throw new Error('通义听悟地域无效。');
    const host = `tingwu.${region}.aliyuncs.com`;
    return { host, href: `https://${host}/`, inputMode: 'remote-url' };
  }
  if (config.providerId === 'tencent-asr') return { host: 'asr.tencentcloudapi.com', href: 'https://asr.tencentcloudapi.com/', inputMode: 'chunks' };
  return { host: '', href: '', inputMode: 'chunks' };
}

function parseConfig(source: string): CloudTranscriptionConfig {
  const value = JSON.parse(source) as Partial<CloudTranscriptionConfig>;
  if (
    value.version !== 1
    || (value.providerId !== 'openai-compatible' && value.providerId !== 'aliyun-tingwu' && value.providerId !== 'tencent-asr')
    || typeof value.model !== 'string' || typeof value.region !== 'string' || typeof value.secretRef !== 'string'
  ) throw new Error('云转录设备配置无效。');
  const expectedRef = value.providerId === 'aliyun-tingwu'
    ? ALIYUN_SECRET_REF
    : value.providerId === 'tencent-asr' ? TENCENT_SECRET_REF : 'session:online-openai-compatible';
  if (value.secretRef !== expectedRef) throw new Error('云转录密钥引用无效。');
  const config = { version: 1, providerId: value.providerId, model: bounded(value.model, '云转录模型'), region: value.region.trim(), secretRef: expectedRef } as const;
  endpoint(config);
  return config;
}

export class CloudTranscriptionConfigStore {
  constructor(readonly filePath: string) {}

  async load(): Promise<CloudTranscriptionConfig> {
    try {
      return parseConfig(await readFile(this.filePath, 'utf8'));
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return DEFAULT_CONFIG;
      throw error;
    }
  }

  async save(config: CloudTranscriptionConfig): Promise<CloudTranscriptionConfig> {
    const validated = parseConfig(JSON.stringify(config));
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, this.filePath);
    return validated;
  }
}

export class CloudTranscriptionService {
  constructor(
    private readonly configStore: CloudTranscriptionConfigStore,
    private readonly secrets: SessionSecretStore,
    private readonly onlineAI: OnlineAIService,
    private readonly fetchImplementation: typeof fetch,
    private readonly readMedia: OnlineMediaReader,
  ) {}

  async settings(): Promise<CloudTranscriptionSettings> {
    const config = await this.configStore.load();
    if (config.providerId === 'openai-compatible') {
      const online = await this.onlineAI.settings();
      return {
        ...config,
        configured: Boolean(config.model && online.endpoint),
        credentialAvailable: online.keyAvailable,
        endpointHost: online.confirmedHost,
        inputMode: 'chunks',
      };
    }
    const target = endpoint(config);
    return {
      ...config,
      configured: Boolean(config.model && config.region),
      credentialAvailable: Boolean(this.secrets.get(config.secretRef)),
      endpointHost: target.host,
      inputMode: target.inputMode,
    };
  }

  async configure(input: ConfigureCloudTranscriptionInput): Promise<CloudTranscriptionSettings> {
    let config: CloudTranscriptionConfig;
    if (input.providerId === 'openai-compatible') {
      config = { version: 1, providerId: input.providerId, model: bounded(input.model, 'OpenAI 转录模型'), region: '', secretRef: 'session:online-openai-compatible' };
    } else if (input.providerId === 'aliyun-tingwu') {
      const region = bounded(input.region, '通义听悟地域', 64);
      config = { version: 1, providerId: input.providerId, model: bounded(input.sourceLanguage, '通义听悟源语言', 64), region, secretRef: ALIYUN_SECRET_REF };
      endpoint(config);
      const credentialValues = [input.accessKeyId.trim(), input.accessKeySecret.trim(), input.appKey.trim()];
      const provided = credentialValues.filter(Boolean).length;
      if (provided > 0 && provided < credentialValues.length) throw new Error('请完整填写 AccessKey ID、AccessKey Secret 和听悟 AppKey。');
      if (provided === credentialValues.length) {
        this.secrets.set(ALIYUN_SECRET_REF, JSON.stringify({
          accessKeyId: bounded(input.accessKeyId, 'AccessKey ID', 512),
          accessKeySecret: bounded(input.accessKeySecret, 'AccessKey Secret', 512),
          appKey: bounded(input.appKey, '听悟 AppKey', 512),
        }));
      } else if (!this.secrets.get(ALIYUN_SECRET_REF)) {
        throw new Error('请填写通义听悟凭据。');
      }
    } else {
      config = { version: 1, providerId: input.providerId, model: bounded(input.engineModelType, '腾讯云引擎模型', 128), region: bounded(input.region, '腾讯云地域', 64), secretRef: TENCENT_SECRET_REF };
      const credentialValues = [input.secretId.trim(), input.secretKey.trim()];
      const provided = credentialValues.filter(Boolean).length;
      if (provided > 0 && provided < credentialValues.length) throw new Error('请完整填写 SecretId 和 SecretKey。');
      if (provided === credentialValues.length) {
        this.secrets.set(TENCENT_SECRET_REF, JSON.stringify({
          secretId: bounded(input.secretId, 'SecretId', 512),
          secretKey: bounded(input.secretKey, 'SecretKey', 512),
          region: config.region,
        }));
      } else if (!this.secrets.get(TENCENT_SECRET_REF)) {
        throw new Error('请填写腾讯云转录凭据。');
      }
    }
    try {
      await this.configStore.save(config);
      return this.settings();
    } catch (error) {
      if (config.providerId !== 'openai-compatible') this.secrets.delete(config.secretRef);
      throw error;
    }
  }

  async runtime(signal?: AbortSignal): Promise<CloudTranscriptionRuntime> {
    const config = await this.configStore.load();
    if (config.providerId === 'openai-compatible') {
      const runtime = await this.onlineAI.transcriptionRuntime(config.model, signal);
      return { ...runtime, inputMode: 'chunks' };
    }
    if (!this.secrets.get(config.secretRef)) throw new Error('云转录凭据只保留在当前会话，请重新输入并保存。');
    const target = endpoint(config);
    const context: AIInvocationContext = {
      resolveSecret: (reference) => Promise.resolve(this.secrets.get(reference)),
      ...(signal ? { signal } : {}),
    };
    const provider = config.providerId === 'aliyun-tingwu'
      ? new AliyunTingwuProvider({ fetch: this.fetchImplementation })
      : new TencentCloudASRProvider({ fetch: this.fetchImplementation, readMedia: this.readMedia });
    return {
      provider,
      config: { providerId: config.providerId, endpoint: target.href, model: config.model, secretRef: config.secretRef },
      context,
      transcriptionModel: config.model,
      host: target.host,
      inputMode: target.inputMode,
    };
  }
}
