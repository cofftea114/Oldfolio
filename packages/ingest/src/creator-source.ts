import { parseFeed } from './rss.js';
import { fetchBoundedText, type SourceUrlPolicy, validateSourceUrl } from './url-policy.js';

export type CreatorPlatform = 'generic' | 'youtube' | 'bilibili' | 'douyin';
export type CreatorSourceMethod = 'direct_feed' | 'homepage_feed' | 'platform_feed' | 'official_api' | 'none';

export interface CreatorSourceResolution {
  readonly inputUrl: string;
  readonly canonicalUrl: string;
  readonly platform: CreatorPlatform;
  readonly status: 'ready' | 'official_api_required' | 'unsupported';
  readonly method: CreatorSourceMethod;
  readonly authorization: 'none' | 'api_key_or_oauth' | 'unavailable';
  readonly feedUrl?: string;
  readonly title?: string;
  readonly entryCount?: number;
  readonly message: string;
}

export interface CreatorSourceResolverOptions {
  readonly fetcher?: typeof fetch;
  readonly urlPolicy?: SourceUrlPolicy;
}

const HOMEPAGE_ACCEPT = 'text/html, application/xhtml+xml, application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, text/plain;q=0.5';
const FEED_MIME_TYPES = new Set([
  'application/rss+xml', 'application/atom+xml',
  'application/xml', 'text/xml',
]);
const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/u;

function platformFor(url: URL): CreatorPlatform {
  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv') return 'bilibili';
  if (host === 'douyin.com' || host.endsWith('.douyin.com')) return 'douyin';
  return 'generic';
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll(/&amp;/giu, '&')
    .replaceAll(/&quot;/giu, '"')
    .replaceAll(/&#39;|&apos;/giu, "'")
    .replaceAll(/&lt;/giu, '<')
    .replaceAll(/&gt;/giu, '>');
}

function attributes(tag: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const expression = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu;
  for (const match of tag.matchAll(expression)) {
    const name = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    if (name && value !== undefined && !(name in result)) result[name] = decodeHtmlAttribute(value);
  }
  return result;
}

function stripExecutableHtml(html: string): string {
  return html
    .replaceAll(/<!--[\s\S]*?-->/gu, '')
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, '')
    .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, '');
}

function youtubeChannelIdFromUrl(url: URL): string | undefined {
  if (platformFor(url) !== 'youtube') return undefined;
  const candidate = url.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/u)?.[1]
    ?? url.searchParams.get('channel_id')
    ?? undefined;
  return candidate && YOUTUBE_CHANNEL_ID.test(candidate) ? candidate : undefined;
}

/** Reads only declarative HTML metadata. Embedded JSON and executable scripts are ignored. */
export function discoverYoutubeChannelId(html: string, pageUrl: string): string | undefined {
  const declarativeHtml = stripExecutableHtml(html);
  for (const match of declarativeHtml.matchAll(/<meta\b[^>]{0,4096}>/giu)) {
    const item = attributes(match[0]);
    if (item.itemprop?.toLowerCase() === 'channelid' && item.content && YOUTUBE_CHANNEL_ID.test(item.content)) {
      return item.content;
    }
  }

  const possibleUrls: string[] = [];
  for (const match of declarativeHtml.matchAll(/<link\b[^>]{0,4096}>/giu)) {
    const item = attributes(match[0]);
    if (item.rel?.toLowerCase().split(/\s+/u).includes('canonical') && item.href) possibleUrls.push(item.href);
  }
  for (const match of declarativeHtml.matchAll(/<meta\b[^>]{0,4096}>/giu)) {
    const item = attributes(match[0]);
    if (item.property?.toLowerCase() === 'og:url' && item.content) possibleUrls.push(item.content);
  }
  for (const candidate of possibleUrls) {
    try {
      const channelId = youtubeChannelIdFromUrl(new URL(candidate, pageUrl));
      if (channelId) return channelId;
    } catch {
      // Ignore malformed untrusted metadata URLs.
    }
  }
  return undefined;
}

/** Reads only declarative alternate-feed links; scripts and page instructions are never executed. */
export function discoverFeedLinks(html: string, pageUrl: string): readonly string[] {
  const base = new URL(pageUrl);
  const discovered: string[] = [];
  const declarativeHtml = stripExecutableHtml(html);
  for (const match of declarativeHtml.matchAll(/<link\b[^>]{0,4096}>/giu)) {
    const item = attributes(match[0]);
    const relations = item.rel?.toLowerCase().split(/\s+/u) ?? [];
    const type = item.type?.toLowerCase().split(';', 1)[0]?.trim();
    if (!relations.includes('alternate') || !item.href || (type && !FEED_MIME_TYPES.has(type))) continue;
    try {
      const candidate = new URL(item.href, base);
      if (candidate.protocol !== 'https:' && candidate.protocol !== 'http:') continue;
      candidate.hash = '';
      discovered.push(candidate.toString());
    } catch {
      // Ignore malformed untrusted link declarations.
    }
    if (discovered.length >= 20) break;
  }
  return [...new Set(discovered)];
}

function platformRequirement(
  inputUrl: string,
  canonicalUrl: string,
  platform: Exclude<CreatorPlatform, 'generic'>,
): CreatorSourceResolution {
  const labels = { youtube: 'YouTube', bilibili: '哔哩哔哩', douyin: '抖音' } as const;
  const message = platform === 'youtube'
    ? '未能从主页的公开元数据解析 YouTube channel ID。可使用 /channel/UC… 地址；按 @handle 查询及完整历史需要用户提供 YouTube Data API Key，Oldfolio 不会回退到页面内容抓取。'
    : `未发现公开 Feed。${labels[platform]} 主页需要经过审核的官方 API 连接器和用户授权，Oldfolio 不会回退到页面爬取。`;
  return {
    inputUrl,
    canonicalUrl,
    platform,
    status: 'official_api_required',
    method: 'official_api',
    authorization: 'api_key_or_oauth',
    message,
  };
}

function feedMessage(format: string, platform: CreatorPlatform, entryCount: number, source: 'direct' | 'homepage' | 'platform'): string {
  if (platform === 'youtube') {
    return `已识别 YouTube ${format.toUpperCase()} Feed，当前公开 Feed 返回 ${entryCount} 条近期内容；Feed 不保证完整历史，完整历史需要 YouTube Data API 分页获取。`;
  }
  if (source === 'homepage') return `主页声明了可用的 ${format.toUpperCase()} Feed，可以无账号追踪。`;
  if (source === 'platform') return `已解析平台公开的 ${format.toUpperCase()} Feed，可以无账号追踪。`;
  return `已识别${format.toUpperCase()} Feed，可直接关注。`;
}

export class CreatorSourceResolver {
  readonly #fetcher: typeof fetch;
  readonly #policy: SourceUrlPolicy;

  constructor(options: CreatorSourceResolverOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
    this.#policy = options.urlPolicy ?? {};
  }

  async #resolveYoutubeFeed(
    inputUrl: string,
    canonicalUrl: string,
    channelId: string,
    signal?: AbortSignal,
  ): Promise<CreatorSourceResolution | undefined> {
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
    try {
      const response = await fetchBoundedText(feedUrl, this.#fetcher, this.#policy, signal);
      const parsed = parseFeed(response.text);
      return {
        inputUrl,
        canonicalUrl,
        platform: 'youtube',
        status: 'ready',
        method: 'platform_feed',
        authorization: 'none',
        feedUrl: response.finalUrl,
        title: parsed.title,
        entryCount: parsed.entries.length,
        message: feedMessage(parsed.format, 'youtube', parsed.entries.length, 'platform'),
      };
    } catch {
      return undefined;
    }
  }

  async resolve(input: string, signal?: AbortSignal): Promise<CreatorSourceResolution> {
    const normalizedInput = validateSourceUrl(input.trim(), this.#policy).toString();
    const normalizedUrl = new URL(normalizedInput);
    const inputPlatform = platformFor(normalizedUrl);
    const inputYoutubeChannelId = youtubeChannelIdFromUrl(normalizedUrl);
    if (inputYoutubeChannelId) {
      const resolved = await this.#resolveYoutubeFeed(normalizedInput, normalizedInput, inputYoutubeChannelId, signal);
      if (resolved) return resolved;
      return platformRequirement(normalizedInput, normalizedInput, 'youtube');
    }
    let homepage;
    try {
      homepage = await fetchBoundedText(normalizedInput, this.#fetcher, {
        ...this.#policy,
        maxBytes: Math.min(this.#policy.maxBytes ?? 2 * 1024 * 1024, 2 * 1024 * 1024),
        accept: HOMEPAGE_ACCEPT,
        truncateAtMaxBytes: true,
      }, signal);
    } catch (error) {
      if (inputPlatform !== 'generic') return platformRequirement(normalizedInput, normalizedInput, inputPlatform);
      throw error;
    }
    const canonical = validateSourceUrl(homepage.finalUrl, this.#policy);
    const platform = platformFor(canonical);
    try {
      const parsed = parseFeed(homepage.text);
      return {
        inputUrl: normalizedInput,
        canonicalUrl: canonical.toString(),
        platform,
        status: 'ready',
        method: 'direct_feed',
        authorization: 'none',
        feedUrl: canonical.toString(),
        title: parsed.title,
        entryCount: parsed.entries.length,
        message: feedMessage(parsed.format, platform, parsed.entries.length, 'direct'),
      };
    } catch {
      // A normal homepage may declaratively expose one or more alternate feeds.
    }

    for (const candidate of discoverFeedLinks(homepage.text, canonical.toString())) {
      try {
        const response = await fetchBoundedText(candidate, this.#fetcher, this.#policy, signal);
        const parsed = parseFeed(response.text);
        return {
          inputUrl: normalizedInput,
          canonicalUrl: canonical.toString(),
          platform,
          status: 'ready',
          method: 'homepage_feed',
          authorization: 'none',
          feedUrl: response.finalUrl,
          title: parsed.title,
          entryCount: parsed.entries.length,
          message: feedMessage(parsed.format, platform, parsed.entries.length, 'homepage'),
        };
      } catch {
        // Try the next bounded, declaratively linked feed candidate.
      }
    }


    if (platform === 'youtube') {
      const channelId = discoverYoutubeChannelId(homepage.text, canonical.toString());
      if (channelId) {
        const resolved = await this.#resolveYoutubeFeed(normalizedInput, canonical.toString(), channelId, signal);
        if (resolved) return resolved;
      }
    }

    if (platform !== 'generic') return platformRequirement(normalizedInput, canonical.toString(), platform);
    return {
      inputUrl: normalizedInput,
      canonicalUrl: canonical.toString(),
      platform,
      status: 'unsupported',
      method: 'none',
      authorization: 'unavailable',
      message: '该主页没有声明 RSS/Atom Feed，当前也没有经过审核的专用连接器。',
    };
  }
}
