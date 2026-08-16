import { createHash, createHmac } from 'node:crypto';

import type {
  AICompletion,
  AIInvocationContext,
  AIModelDescriptor,
  AIProvider,
  AIProviderConfig,
  AITranscriptSegment,
  AITranscriptionRequest,
  AITranscriptionResult,
} from '@oldfolio/domain';

import type { ProviderOptions } from './provider.js';
import { AIProviderError } from './provider.js';

const TENCENT_ENDPOINT = new URL('https://asr.tencentcloudapi.com/');
const TENCENT_VERSION = '2019-06-14';
const TENCENT_MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const MAX_CONTROL_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface AsyncProviderOptions extends ProviderOptions {
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => Date;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
}

interface TencentCredential {
  readonly secretId: string;
  readonly secretKey: string;
  readonly region?: string;
}

function boundedCredential(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) {
    throw new AIProviderError(`${field}无效。`);
  }
  return value.trim();
}

async function resolveCredential<T extends object>(
  config: AIProviderConfig,
  context: AIInvocationContext | undefined,
  fields: readonly string[],
): Promise<T> {
  if (!config.secretRef || !context) throw new AIProviderError('云转录凭据仅能通过受控密钥引用提供。');
  const serialized = await context.resolveSecret(config.secretRef);
  if (!serialized) throw new AIProviderError('当前会话没有可用的云转录凭据，请重新输入。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new AIProviderError('云转录凭据格式无效。');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new AIProviderError('云转录凭据格式无效。');
  const record = parsed as Record<string, unknown>;
  for (const field of fields) boundedCredential(record[field], field);
  return record as T;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('云转录已取消。'));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('云转录已取消。'));
    }, { once: true });
  });
}

async function readBoundedJson(response: Response, maxBytes = MAX_CONTROL_RESPONSE_BYTES): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new AIProviderError('云转录响应超过安全大小限制。');
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel('response too large');
      throw new AIProviderError('云转录响应超过安全大小限制。');
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new AIProviderError('云转录服务返回了无效 JSON。', response.status);
  }
}

function providerError(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const nested = typeof record['Error'] === 'object' && record['Error'] !== null
    ? record['Error'] as Record<string, unknown>
    : record;
  const code = typeof nested['Code'] === 'string' ? nested['Code'] : undefined;
  const message = typeof nested['Message'] === 'string' ? nested['Message'] : undefined;
  const raw = [code, message].filter(Boolean).join(': ');
  const sanitized = [...raw].map((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127 ? ' ' : character;
  }).join('').slice(0, 500);
  return sanitized || undefined;
}

function unsupportedCompletion(): Promise<AICompletion> {
  return Promise.reject(new AIProviderError('该 Provider 仅支持语音转录，不支持摘要生成。'));
}

function staticModels(id: string, displayName: string): readonly AIModelDescriptor[] {
  return [{ id, displayName, capabilities: ['transcription'], local: false }];
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmacSha256(key: string | Uint8Array, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

export function signTencentCloudRequest(input: {
  readonly secretId: string;
  readonly secretKey: string;
  readonly action: string;
  readonly body: string;
  readonly timestamp: number;
  readonly region?: string;
}): Headers {
  const algorithm = 'TC3-HMAC-SHA256';
  const service = 'asr';
  const host = TENCENT_ENDPOINT.host;
  const contentType = 'application/json; charset=utf-8';
  const date = new Date(input.timestamp * 1_000).toISOString().slice(0, 10);
  const signedHeaders = 'content-type;host';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(input.body)}`;
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = `${algorithm}\n${input.timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const secretDate = hmacSha256(`TC3${input.secretKey}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, 'tc3_request');
  const signature = createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
  // `host` remains part of the TC3 canonical signature, but Chromium must create
  // the actual Host header from the request URL; Electron net.fetch rejects an
  // explicitly supplied Host header with net::ERR_INVALID_ARGUMENT.
  const headers = new Headers({
    Authorization: `${algorithm} Credential=${input.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': contentType,
    'X-TC-Action': input.action,
    'X-TC-Timestamp': String(input.timestamp),
    'X-TC-Version': TENCENT_VERSION,
  });
  if (input.region) headers.set('X-TC-Region', input.region);
  return headers;
}

function tencentSegments(data: Record<string, unknown>, fallbackDurationMs: number): readonly AITranscriptSegment[] {
  const details = Array.isArray(data['ResultDetail']) ? data['ResultDetail'] : [];
  const segments = details.flatMap((value) => {
    if (typeof value !== 'object' || value === null) return [];
    const row = value as Record<string, unknown>;
    const text = typeof row['FinalSentence'] === 'string' ? row['FinalSentence'].trim() : '';
    const startMs = row['StartMs'];
    const endMs = row['EndMs'];
    if (!text || typeof startMs !== 'number' || typeof endMs !== 'number' || startMs < 0 || endMs < startMs) return [];
    return [{
      startMs: Math.round(startMs), endMs: Math.max(Math.round(endMs), Math.round(startMs) + 1), text,
      ...(typeof row['SpeakerId'] === 'number' ? { speaker: `speaker-${row['SpeakerId']}` } : {}),
    }];
  });
  if (segments.length) return segments;
  const text = typeof data['Result'] === 'string'
    ? data['Result'].replaceAll(/^\[[^\]]+\]\s*/gmu, '').trim()
    : '';
  return text ? [{ startMs: 0, endMs: Math.max(1, fallbackDurationMs), text }] : [];
}

export class TencentCloudASRProvider implements AIProvider {
  readonly id = 'tencent-asr';
  readonly displayName = '腾讯云语音识别';
  readonly capabilities = ['transcription'] as const;
  readonly #options: AsyncProviderOptions;

  constructor(options: AsyncProviderOptions = {}) {
    this.#options = options;
  }

  listModels(config: AIProviderConfig): Promise<readonly AIModelDescriptor[]> {
    return Promise.resolve(staticModels(config.model || '16k_zh_en_2.0', '腾讯云录音文件识别'));
  }

  complete(): Promise<AICompletion> {
    return unsupportedCompletion();
  }

  async transcribe(config: AIProviderConfig, request: AITranscriptionRequest, context?: AIInvocationContext): Promise<AITranscriptionResult> {
    if (!this.#options.readMedia) throw new AIProviderError('腾讯云转录缺少受控媒体读取器。');
    const credential = await resolveCredential<TencentCredential>(config, context, ['secretId', 'secretKey']);
    const media = await this.#options.readMedia(request.mediaUri, context?.signal);
    if (!media.bytes.byteLength || media.bytes.byteLength > TENCENT_MAX_AUDIO_BYTES) {
      throw new AIProviderError('腾讯云本地音频数据必须大于 0 且不超过 5 MB。');
    }
    const createBody = JSON.stringify({
      EngineModelType: config.model || '16k_zh_en_2.0',
      ChannelNum: 1,
      ResTextFormat: 1,
      SourceType: 1,
      Data: Buffer.from(media.bytes).toString('base64'),
      DataLen: media.bytes.byteLength,
    });
    const created = await this.#request('CreateRecTask', createBody, credential, context?.signal);
    const createResponse = typeof created === 'object' && created !== null
      ? (created as Record<string, unknown>)['Response']
      : undefined;
    if (typeof createResponse !== 'object' || createResponse === null) throw new AIProviderError('腾讯云没有返回任务信息。');
    const createRecord = createResponse as Record<string, unknown>;
    if (createRecord['Error']) throw new AIProviderError(`腾讯云创建任务失败：${providerError(createRecord['Error']) ?? '未知错误'}`);
    const task = typeof createRecord['Data'] === 'object' && createRecord['Data'] !== null
      ? createRecord['Data'] as Record<string, unknown>
      : undefined;
    const taskId = task?.['TaskId'];
    if (typeof taskId !== 'number' && typeof taskId !== 'string') throw new AIProviderError('腾讯云没有返回有效 TaskId。');

    const sleep = this.#options.sleep ?? defaultSleep;
    const maxPolls = this.#options.maxPolls ?? 5_400;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (poll > 0) await sleep(this.#options.pollIntervalMs ?? 2_000, context?.signal);
      const status = await this.#request('DescribeTaskStatus', JSON.stringify({ TaskId: taskId }), credential, context?.signal);
      const response = typeof status === 'object' && status !== null ? (status as Record<string, unknown>)['Response'] : undefined;
      if (typeof response !== 'object' || response === null) throw new AIProviderError('腾讯云任务查询响应无效。');
      const responseRecord = response as Record<string, unknown>;
      if (responseRecord['Error']) throw new AIProviderError(`腾讯云任务查询失败：${providerError(responseRecord['Error']) ?? '未知错误'}`);
      const data = typeof responseRecord['Data'] === 'object' && responseRecord['Data'] !== null
        ? responseRecord['Data'] as Record<string, unknown>
        : undefined;
      if (!data) throw new AIProviderError('腾讯云任务查询没有返回数据。');
      if (data['Status'] === 3 || data['StatusStr'] === 'failed') {
        throw new AIProviderError(`腾讯云转录失败：${boundedCredential(data['ErrorMsg'] ?? '未知错误', '错误信息')}`);
      }
      if (data['Status'] !== 2 && data['StatusStr'] !== 'success') continue;
      const segments = tencentSegments(data, request.durationMs ?? 1);
      if (!segments.length) throw new AIProviderError('腾讯云任务完成但没有返回可用文案。');
      return { text: segments.map((segment) => segment.text).join('\n'), segments, ...(request.language ? { language: request.language } : {}) };
    }
    throw new AIProviderError('腾讯云转录等待超时，可稍后从任务列表继续。');
  }

  async #request(action: string, body: string, credential: TencentCredential, signal?: AbortSignal): Promise<unknown> {
    const timestamp = Math.floor((this.#options.now?.() ?? new Date()).getTime() / 1_000);
    const headers = signTencentCloudRequest({
      secretId: credential.secretId,
      secretKey: credential.secretKey,
      action,
      body,
      timestamp,
      ...(credential.region ? { region: credential.region } : {}),
    });
    const response = await (this.#options.fetch ?? fetch)(TENCENT_ENDPOINT, {
      method: 'POST', headers, body, redirect: 'manual', credentials: 'omit', ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new AIProviderError(`腾讯云 API 请求失败（HTTP ${response.status}）。`, response.status);
    return readBoundedJson(response);
  }
}
