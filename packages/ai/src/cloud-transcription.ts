import { createHash, createHmac, randomUUID } from 'node:crypto';

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
const ALIYUN_VERSION = '2023-09-30';
const MAX_CONTROL_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_RESPONSE_BYTES = 64 * 1024 * 1024;

export interface AsyncProviderOptions extends ProviderOptions {
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => Date;
  readonly nonce?: () => string;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
}

interface TencentCredential {
  readonly secretId: string;
  readonly secretKey: string;
  readonly region?: string;
}

interface AliyunCredential {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly appKey: string;
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
  const headers = new Headers({
    Authorization: `${algorithm} Credential=${input.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': contentType,
    Host: host,
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

function md5Base64(value: string): string {
  return createHash('md5').update(value).digest('base64');
}

export function signAliyunRoaRequest(input: {
  readonly method: 'GET' | 'PUT';
  readonly host: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly date: Date;
  readonly nonce: string;
}): { readonly url: URL; readonly headers: Headers } {
  const body = input.body ?? '';
  const contentType = body ? 'application/json' : '';
  const contentMd5 = body ? md5Base64(body) : '';
  const date = input.date.toUTCString();
  const acsHeaders: Readonly<Record<string, string>> = {
    'x-acs-signature-method': 'HMAC-SHA1',
    'x-acs-signature-nonce': input.nonce,
    'x-acs-signature-version': '1.0',
    'x-acs-version': ALIYUN_VERSION,
  };
  const canonicalHeaders = Object.entries(acsHeaders).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}\n`).join('');
  const query = new URLSearchParams(Object.entries(input.query ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  const canonicalResource = `${input.path}${query.size ? `?${query.toString()}` : ''}`;
  const stringToSign = `${input.method}\napplication/json\n${contentMd5}\n${contentType}\n${date}\n${canonicalHeaders}${canonicalResource}`;
  const signature = createHmac('sha1', input.accessKeySecret).update(stringToSign).digest('base64');
  const url = new URL(`https://${input.host}${canonicalResource}`);
  const headers = new Headers({
    Accept: 'application/json',
    Authorization: `acs ${input.accessKeyId}:${signature}`,
    Date: date,
    Host: input.host,
    ...acsHeaders,
  });
  if (body) {
    headers.set('Content-MD5', contentMd5);
    headers.set('Content-Type', contentType);
  }
  return { url, headers };
}

function aliyunSegments(value: unknown, fallbackDurationMs: number): { readonly language?: string; readonly segments: readonly AITranscriptSegment[] } {
  if (typeof value !== 'object' || value === null) throw new AIProviderError('通义听悟转写结果无效。');
  const transcription = (value as Record<string, unknown>)['Transcription'];
  if (typeof transcription !== 'object' || transcription === null) throw new AIProviderError('通义听悟转写结果缺少 Transcription。');
  const record = transcription as Record<string, unknown>;
  const paragraphs = Array.isArray(record['Paragraphs']) ? record['Paragraphs'] : [];
  const segments: AITranscriptSegment[] = [];
  for (const paragraph of paragraphs) {
    if (typeof paragraph !== 'object' || paragraph === null) continue;
    const paragraphRecord = paragraph as Record<string, unknown>;
    const speaker = typeof paragraphRecord['SpeakerId'] === 'string' ? paragraphRecord['SpeakerId'] : undefined;
    const words = Array.isArray(paragraphRecord['Words']) ? paragraphRecord['Words'] : [];
    const grouped = new Map<string, { startMs: number; endMs: number; text: string[] }>();
    for (const word of words) {
      if (typeof word !== 'object' || word === null) continue;
      const item = word as Record<string, unknown>;
      const text = typeof item['Text'] === 'string' ? item['Text'] : '';
      const start = item['Start'];
      const end = item['End'];
      const sentenceId = item['SentenceId'];
      if (!text || typeof start !== 'number' || typeof end !== 'number' || end < start) continue;
      const id = typeof sentenceId === 'number' || typeof sentenceId === 'string' ? String(sentenceId) : `word-${segments.length}`;
      const existing = grouped.get(id);
      if (existing) {
        existing.startMs = Math.min(existing.startMs, start);
        existing.endMs = Math.max(existing.endMs, end);
        existing.text.push(text);
      } else {
        grouped.set(id, { startMs: start, endMs: end, text: [text] });
      }
    }
    for (const sentence of grouped.values()) {
      const text = sentence.text.join('').trim();
      if (text) segments.push({
        startMs: Math.round(sentence.startMs), endMs: Math.max(Math.round(sentence.endMs), Math.round(sentence.startMs) + 1), text,
        ...(speaker ? { speaker } : {}),
      });
    }
  }
  const audioInfo = typeof record['AudioInfo'] === 'object' && record['AudioInfo'] !== null
    ? record['AudioInfo'] as Record<string, unknown>
    : {};
  if (!segments.length && typeof record['Text'] === 'string' && record['Text'].trim()) {
    segments.push({ startMs: 0, endMs: Math.max(1, typeof audioInfo['Duration'] === 'number' ? audioInfo['Duration'] : fallbackDurationMs), text: record['Text'].trim() });
  }
  return {
    segments: segments.sort((left, right) => left.startMs - right.startMs),
    ...(typeof audioInfo['Language'] === 'string' ? { language: audioInfo['Language'] } : {}),
  };
}

export class AliyunTingwuProvider implements AIProvider {
  readonly id = 'aliyun-tingwu';
  readonly displayName = '阿里云通义听悟';
  readonly capabilities = ['transcription'] as const;
  readonly #options: AsyncProviderOptions;

  constructor(options: AsyncProviderOptions = {}) {
    this.#options = options;
  }

  listModels(config: AIProviderConfig): Promise<readonly AIModelDescriptor[]> {
    return Promise.resolve(staticModels(config.model || 'auto', '通义听悟离线转写'));
  }

  complete(): Promise<AICompletion> {
    return unsupportedCompletion();
  }

  async transcribe(config: AIProviderConfig, request: AITranscriptionRequest, context?: AIInvocationContext): Promise<AITranscriptionResult> {
    const source = new URL(request.mediaUri);
    if (source.protocol !== 'https:' || source.username || source.password || !source.hostname || source.hostname === 'localhost') {
      throw new AIProviderError('通义听悟只接受不含凭据的公网 HTTPS 音视频 URL。');
    }
    const credential = await resolveCredential<AliyunCredential>(config, context, ['accessKeyId', 'accessKeySecret', 'appKey']);
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== 'https:' || !/^tingwu\.[a-z0-9-]+\.aliyuncs\.com$/iu.test(endpoint.hostname)) {
      throw new AIProviderError('通义听悟 Endpoint 无效。');
    }
    const body = JSON.stringify({
      AppKey: credential.appKey,
      Input: { FileUrl: source.href, SourceLanguage: request.language || config.model || 'auto', TaskKey: randomUUID() },
      Parameters: { Transcription: { DiarizationEnabled: true, Diarization: { SpeakerCount: 0 } } },
    });
    const created = await this.#request('PUT', endpoint.hostname, '/openapi/tingwu/v2/tasks', { type: 'offline' }, body, credential, context?.signal);
    if (typeof created !== 'object' || created === null) throw new AIProviderError('通义听悟没有返回任务信息。');
    const createRecord = created as Record<string, unknown>;
    if (createRecord['Code'] !== '0' && createRecord['Code'] !== 0) throw new AIProviderError(`通义听悟创建任务失败：${providerError(createRecord) ?? '未知错误'}`);
    const createData = typeof createRecord['Data'] === 'object' && createRecord['Data'] !== null
      ? createRecord['Data'] as Record<string, unknown>
      : undefined;
    const taskId = createData?.['TaskId'];
    if (typeof taskId !== 'string' || !taskId) throw new AIProviderError('通义听悟没有返回有效 TaskId。');

    const sleep = this.#options.sleep ?? defaultSleep;
    const maxPolls = this.#options.maxPolls ?? 180;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (poll > 0) await sleep(this.#options.pollIntervalMs ?? 60_000, context?.signal);
      const status = await this.#request('GET', endpoint.hostname, `/openapi/tingwu/v2/tasks/${encodeURIComponent(taskId)}`, undefined, undefined, credential, context?.signal);
      if (typeof status !== 'object' || status === null) throw new AIProviderError('通义听悟任务查询响应无效。');
      const statusRecord = status as Record<string, unknown>;
      if (statusRecord['Code'] !== '0' && statusRecord['Code'] !== 0) throw new AIProviderError(`通义听悟任务查询失败：${providerError(statusRecord) ?? '未知错误'}`);
      const data = typeof statusRecord['Data'] === 'object' && statusRecord['Data'] !== null
        ? statusRecord['Data'] as Record<string, unknown>
        : undefined;
      if (!data) throw new AIProviderError('通义听悟任务查询没有返回数据。');
      if (data['TaskStatus'] === 'FAILED' || data['TaskStatus'] === 'INVALID') {
        throw new AIProviderError(`通义听悟转录失败：${providerError({ Code: data['ErrorCode'], Message: data['ErrorMessage'] }) ?? '未知错误'}`);
      }
      if (data['TaskStatus'] !== 'COMPLETED') continue;
      const result = typeof data['Result'] === 'object' && data['Result'] !== null ? data['Result'] as Record<string, unknown> : undefined;
      const transcriptionUrl = result?.['Transcription'];
      if (typeof transcriptionUrl !== 'string') throw new AIProviderError('通义听悟任务完成但没有返回转写结果地址。');
      const resultUrl = new URL(transcriptionUrl.replaceAll('&amp;', '&'));
      if (resultUrl.protocol === 'http:' && resultUrl.hostname.endsWith('.aliyuncs.com')) resultUrl.protocol = 'https:';
      if (resultUrl.protocol !== 'https:' || !resultUrl.hostname.endsWith('.aliyuncs.com')) throw new AIProviderError('通义听悟返回了不受信任的结果地址。');
      const response = await (this.#options.fetch ?? fetch)(resultUrl, { method: 'GET', redirect: 'manual', credentials: 'omit', ...(context?.signal ? { signal: context.signal } : {}) });
      if (!response.ok) throw new AIProviderError(`通义听悟结果下载失败（HTTP ${response.status}）。`, response.status);
      const parsed = aliyunSegments(await readBoundedJson(response, MAX_TRANSCRIPT_RESPONSE_BYTES), request.durationMs ?? 1);
      if (!parsed.segments.length) throw new AIProviderError('通义听悟任务完成但没有返回可用文案。');
      return { text: parsed.segments.map((segment) => segment.text).join('\n'), segments: parsed.segments, ...(parsed.language ? { language: parsed.language } : request.language ? { language: request.language } : {}) };
    }
    throw new AIProviderError('通义听悟转录等待超时，可稍后从任务列表继续。');
  }

  async #request(
    method: 'GET' | 'PUT', host: string, path: string, query: Readonly<Record<string, string>> | undefined,
    body: string | undefined, credential: AliyunCredential, signal?: AbortSignal,
  ): Promise<unknown> {
    const signed = signAliyunRoaRequest({
      method, host, path, ...(query ? { query } : {}), ...(body ? { body } : {}),
      accessKeyId: credential.accessKeyId, accessKeySecret: credential.accessKeySecret,
      date: this.#options.now?.() ?? new Date(), nonce: this.#options.nonce?.() ?? randomUUID(),
    });
    const response = await (this.#options.fetch ?? fetch)(signed.url, {
      method, headers: signed.headers, ...(body ? { body } : {}), redirect: 'manual', credentials: 'omit', ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new AIProviderError(`通义听悟 API 请求失败（HTTP ${response.status}）。`, response.status);
    return readBoundedJson(response);
  }
}
