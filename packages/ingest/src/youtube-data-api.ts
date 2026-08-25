import { createHash } from 'node:crypto';

import type {
  SourceCapability,
  SourceConnector,
  SourceFetchRequest,
  SourceInput,
  SourceInvocationContext,
  SourceProbeResult,
  SourceSnapshot,
} from '@oldfolio/domain';

const API_ROOT = 'https://www.googleapis.com/youtube/v3/';
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/u;
const MAX_API_KEY_LENGTH = 4_096;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 2_000;
const MAX_PAGES = MAX_HISTORY_ENTRIES / 50;
const REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
const SUPPORTED = new Set<SourceCapability>(['metadata', 'content', 'subscription']);

type JsonRecord = Record<string, unknown>;

export interface YouTubeChannelSummary {
  readonly id: string;
  readonly title: string;
  readonly uploadsPlaylistId: string;
  readonly canonicalUrl: string;
  readonly feedUrl: string;
}

export interface YouTubeHistoryResult {
  readonly channel: YouTubeChannelSummary;
  readonly entries: readonly YouTubeHistoryEntry[];
  readonly complete: boolean;
  readonly totalResults?: number;
  readonly pageCount: number;
}

export interface YouTubeHistoryEntry {
  readonly id: string;
  readonly title: string;
  readonly link: string;
  readonly publishedAt?: string;
  readonly author?: string;
}

export interface YouTubeDataApiConnectorOptions {
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
}

export class YouTubeDataApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'YouTubeDataApiError';
  }
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function boundedString(value: unknown, field: string, max = 4_096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new YouTubeDataApiError(`YouTube Data API 返回了无效的${field}。`);
  }
  return value.trim();
}

function optionalString(value: unknown, max = 4_096): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0')
    ? value.trim()
    : undefined;
}

function normalizeApiKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > MAX_API_KEY_LENGTH || key.includes('\0')) throw new YouTubeDataApiError('YouTube Data API Key 无效。');
  return key;
}

function youtubeTarget(input: SourceInput): { readonly id?: string; readonly handle?: string; readonly canonicalInput: string } | undefined {
  if (input.kind !== 'url') return undefined;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || (host !== 'youtube.com' && !host.endsWith('.youtube.com'))) return undefined;
  const pathId = url.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/u)?.[1];
  const queryId = url.pathname === '/feeds/videos.xml' ? url.searchParams.get('channel_id') : undefined;
  const id = pathId ?? queryId ?? undefined;
  if (id && CHANNEL_ID.test(id)) return { id, canonicalInput: url.toString() };
  const handle = decodeURIComponent(url.pathname).match(/^\/@([^/?#]{1,100})(?:\/|$)/u)?.[1];
  return handle ? { handle: `@${handle}`, canonicalInput: url.toString() } : undefined;
}

function sanitizedApiMessage(value: unknown): string | undefined {
  const message = optionalString(value, 500);
  return message?.replaceAll(/[\r\n\0]+/gu, ' ').trim();
}

function apiError(body: unknown, status: number): YouTubeDataApiError {
  const error = record(record(body)?.error);
  const details = Array.isArray(error?.errors) ? record(error.errors[0]) : undefined;
  const reason = optionalString(details?.reason, 128);
  const message = sanitizedApiMessage(error?.message);
  const suffix = [reason, message].filter(Boolean).join('：');
  return new YouTubeDataApiError(
    `YouTube Data API 请求失败（HTTP ${status}）${suffix ? `：${suffix}` : ''}`,
    status,
    reason,
  );
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new YouTubeDataApiError('YouTube Data API 响应超过大小限制。');
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel('response too large');
      throw new YouTubeDataApiError('YouTube Data API 响应超过大小限制。');
    }
    chunks.push(result.value);
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
    throw new YouTubeDataApiError('YouTube Data API 返回了无效 JSON。');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function markdownText(value: string): string {
  return value.replaceAll(/[\\`*_{}<>#]/gu, '\\$&').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

export class YouTubeDataApiConnector implements SourceConnector {
  readonly id = 'org.oldfolio.youtube-data-api';
  readonly displayName = 'YouTube Data API';
  readonly accessMethods = ['official_api'] as const;
  readonly retentionPolicy = {
    handlesRemoteDeletionSignals: false,
    supportsUserErasure: true,
    defaultRefreshIntervalMs: REFRESH_INTERVAL_MS,
    notes: 'Public upload-list absence is not treated as an instruction to erase retained source history.',
  } as const;

  readonly #fetcher: typeof fetch;
  readonly #now: () => Date;

  constructor(options: YouTubeDataApiConnectorOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  probe(input: SourceInput): Promise<SourceProbeResult> {
    const target = youtubeTarget(input);
    return Promise.resolve(target ? {
      matched: true,
      canonicalUri: target.canonicalInput,
      capabilities: [
        { capability: 'metadata', availability: 'authorization_required', authorization: 'api_key' },
        { capability: 'content', availability: 'authorization_required', authorization: 'api_key' },
        { capability: 'subscription', availability: 'authorization_required', authorization: 'api_key' },
        { capability: 'captions', availability: 'unsupported', authorization: 'api_key' },
        { capability: 'comments', availability: 'unsupported', authorization: 'api_key' },
      ],
    } : { matched: false, capabilities: [] });
  }

  async resolveChannel(input: SourceInput, secretRef: string, context?: SourceInvocationContext): Promise<YouTubeChannelSummary> {
    const target = youtubeTarget(input);
    if (!target) throw new YouTubeDataApiError('请输入 YouTube 的 /@handle、/channel/UC… 或公开 Feed 地址。');
    const apiKey = await this.resolveApiKey(secretRef, context);
    const url = new URL('channels', API_ROOT);
    url.searchParams.set('part', 'snippet,contentDetails');
    url.searchParams.set('fields', 'items(id,snippet(title),contentDetails(relatedPlaylists(uploads)))');
    if (target.id) url.searchParams.set('id', target.id);
    else url.searchParams.set('forHandle', target.handle!);
    const response = record(await this.request(url, apiKey, context?.signal));
    const item = Array.isArray(response?.items) ? record(response.items[0]) : undefined;
    if (!item) throw new YouTubeDataApiError('YouTube Data API 未找到该频道。', 404, 'channelNotFound');
    const id = boundedString(item.id, '频道 ID', 64);
    if (!CHANNEL_ID.test(id)) throw new YouTubeDataApiError('YouTube Data API 返回了无效的频道 ID。');
    const title = boundedString(record(item.snippet)?.title, '频道标题', 1_000);
    const uploadsPlaylistId = boundedString(
      record(record(item.contentDetails)?.relatedPlaylists)?.uploads,
      '上传播放列表 ID',
      128,
    );
    return {
      id,
      title,
      uploadsPlaylistId,
      canonicalUrl: `https://www.youtube.com/channel/${id}`,
      feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,
    };
  }

  async fetchHistory(input: SourceInput, secretRef: string, context?: SourceInvocationContext): Promise<YouTubeHistoryResult> {
    const apiKey = await this.resolveApiKey(secretRef, context);
    const channel = await this.resolveChannel(input, secretRef, context);
    const entries: YouTubeHistoryEntry[] = [];
    let nextPageToken: string | undefined;
    let totalResults: number | undefined;
    let pageCount = 0;
    do {
      const url = new URL('playlistItems', API_ROOT);
      url.searchParams.set('part', 'snippet,contentDetails,status');
      url.searchParams.set('fields', 'nextPageToken,pageInfo(totalResults),items(contentDetails(videoId),snippet(title,publishedAt,channelTitle),status(privacyStatus))');
      url.searchParams.set('playlistId', channel.uploadsPlaylistId);
      url.searchParams.set('maxResults', '50');
      if (nextPageToken) url.searchParams.set('pageToken', nextPageToken);
      const page = record(await this.request(url, apiKey, context?.signal));
      pageCount += 1;
      const pageTotal = Number(record(page?.pageInfo)?.totalResults);
      if (Number.isSafeInteger(pageTotal) && pageTotal >= 0) totalResults = pageTotal;
      for (const value of Array.isArray(page?.items) ? page.items : []) {
        const item = record(value);
        const videoId = optionalString(record(item?.contentDetails)?.videoId, 64);
        const snippet = record(item?.snippet);
        const privacy = optionalString(record(item?.status)?.privacyStatus, 32);
        const title = optionalString(snippet?.title, 1_000);
        if (!videoId || !title || (privacy && privacy !== 'public')) continue;
        const publishedAt = optionalString(snippet?.publishedAt, 64);
        const author = optionalString(snippet?.channelTitle, 1_000);
        entries.push({
          id: `yt:video:${videoId}`,
          title,
          link: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
          ...(publishedAt && Number.isFinite(Date.parse(publishedAt)) ? { publishedAt: new Date(publishedAt).toISOString() } : {}),
          ...(author ? { author } : {}),
        });
        if (entries.length >= MAX_HISTORY_ENTRIES) break;
      }
      nextPageToken = optionalString(page?.nextPageToken, 512);
    } while (nextPageToken && entries.length < MAX_HISTORY_ENTRIES && pageCount < MAX_PAGES);
    return {
      channel,
      entries,
      complete: !nextPageToken,
      ...(totalResults === undefined ? {} : { totalResults }),
      pageCount,
    };
  }

  async fetch(request: SourceFetchRequest, context?: SourceInvocationContext): Promise<SourceSnapshot> {
    if (request.input.kind !== 'url') throw new YouTubeDataApiError('YouTube Data API 连接器需要频道 URL。');
    for (const capability of request.capabilities) {
      if (!SUPPORTED.has(capability)) throw new YouTubeDataApiError(`YouTube Data API 连接器不支持 ${capability}。`);
    }
    if (!request.secretRef) throw new YouTubeDataApiError('YouTube Data API Key 只能通过受控密钥引用提供。');
    const result = await this.fetchHistory(request.input, request.secretRef, context);
    const fetchedAt = this.#now();
    const serialized = JSON.stringify({ channel: result.channel, entries: result.entries });
    const contentHash = sha256(serialized);
    const lineageId = `youtube-channel-${result.channel.id}`;
    const text = [
      `# ${markdownText(result.channel.title)}`,
      '',
      ...result.entries.flatMap((entry) => [
        `## ${markdownText(entry.title)}`,
        `- Video: ${entry.link}`,
        ...(entry.publishedAt ? [`- Published: ${entry.publishedAt}`] : []),
        '',
      ]),
    ].join('\n').trimEnd();
    return {
      id: `${lineageId}-${contentHash.slice(0, 16)}`,
      connectorId: this.id,
      canonicalUri: result.channel.canonicalUrl,
      fetchedAt: fetchedAt.toISOString(),
      contentHash,
      title: `${result.channel.title} — YouTube uploads`,
      mimeType: 'application/json',
      text,
      metadata: {
        sourceLineageId: lineageId,
        channelId: result.channel.id,
        feedUrl: result.channel.feedUrl,
        uploadsPlaylistId: result.channel.uploadsPlaylistId,
        entries: result.entries,
        complete: result.complete,
        pageCount: result.pageCount,
        ...(result.totalResults === undefined ? {} : { totalResults: result.totalResults }),
      },
      deletionPolicy: {
        supportsRemoteDeletionSignals: false,
        refreshAfter: new Date(fetchedAt.getTime() + REFRESH_INTERVAL_MS).toISOString(),
      },
    };
  }

  private async resolveApiKey(secretRef: string, context?: SourceInvocationContext): Promise<string> {
    if (!secretRef.trim() || !context) throw new YouTubeDataApiError('YouTube Data API Key 只能通过受控密钥引用提供。');
    const secret = await context.resolveSecret(secretRef);
    if (!secret) throw new YouTubeDataApiError('没有可用的 YouTube Data API Key。');
    return normalizeApiKey(secret);
  }

  private async request(url: URL, apiKey: string, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000);
      response = await this.#fetcher(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'manual',
        headers: { Accept: 'application/json', 'X-Goog-Api-Key': apiKey },
        signal: requestSignal,
      });
    } catch (error) {
      throw new YouTubeDataApiError(`无法连接 YouTube Data API：${error instanceof Error ? error.message : '网络错误'}`);
    }
    const body = await readBoundedJson(response);
    if (!response.ok) throw apiError(body, response.status);
    return body;
  }
}
