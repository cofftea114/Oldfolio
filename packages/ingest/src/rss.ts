import type {
  OperationContext,
  SourceCapability,
  SourceConnector,
  SourceFetchRequest,
  SourceInput,
  SourceProbeResult,
  SourceSnapshot,
} from '@oldfolio/domain';
import { XMLParser } from 'fast-xml-parser';

import { sha256 } from './hash.js';
import { fetchBoundedText, validateSourceUrl, type SourceUrlPolicy } from './url-policy.js';

export interface FeedEntry {
  readonly id: string;
  readonly title: string;
  readonly link?: string;
  readonly publishedAt?: string;
  readonly author?: string;
  readonly summary?: string;
  readonly enclosure?: {
    readonly url: string;
    readonly mimeType?: string;
    readonly byteLength?: number;
  };
  readonly duration?: string;
}

export interface RssConnectorOptions {
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
  readonly urlPolicy?: SourceUrlPolicy;
}

const SUPPORTED = new Set<SourceCapability>(['metadata', 'content', 'subscription']);
const MAX_ENTRIES = 1_000;
const MAX_FIELD_LENGTH = 20_000;

type XmlRecord = Record<string, unknown>;

function record(value: unknown): XmlRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as XmlRecord)
    : undefined;
}

function values(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  const object = record(value);
  if (!object) return undefined;
  return scalar(object['#text'] ?? object['__cdata']);
}

function plainText(value: unknown): string | undefined {
  const raw = scalar(value);
  if (!raw) return undefined;
  return raw
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replaceAll(/<[^>]+>/gu, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_FIELD_LENGTH);
}

function normalizeDate(value: unknown): string | undefined {
  const raw = scalar(value);
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function safeRemoteLink(value: unknown): string | undefined {
  const raw = scalar(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function atomLink(value: unknown): string | undefined {
  for (const candidate of values(value)) {
    const object = record(candidate);
    if (!object) continue;
    const relation = scalar(object['@_rel']);
    const href = safeRemoteLink(object['@_href']);
    if (href && (relation === undefined || relation === 'alternate')) return href;
  }
  return undefined;
}

function parseEnclosure(value: unknown): FeedEntry['enclosure'] | undefined {
  const object = record(value);
  if (!object) return undefined;
  const url = safeRemoteLink(object['@_url'] ?? object['@_href']);
  if (!url) return undefined;
  const mimeType = scalar(object['@_type']);
  const parsedLength = Number(scalar(object['@_length']));
  return {
    url,
    ...(mimeType ? { mimeType } : {}),
    ...(Number.isSafeInteger(parsedLength) && parsedLength >= 0 ? { byteLength: parsedLength } : {}),
  };
}

function parseRss(root: XmlRecord): { title: string; entries: FeedEntry[]; podcast: boolean } | undefined {
  const channel = record(record(root.rss)?.channel);
  if (!channel) return undefined;
  const entries = values(channel.item).slice(0, MAX_ENTRIES).map((item, index): FeedEntry => {
    const value = record(item) ?? {};
    const link = safeRemoteLink(value.link);
    const guid = scalar(value.guid);
    const title = plainText(value.title) ?? `Untitled item ${index + 1}`;
    const enclosure = parseEnclosure(value.enclosure);
    const publishedAt = normalizeDate(value.pubDate ?? value['dc:date']);
    const author = plainText(value.author ?? value['dc:creator']);
    const summary = plainText(value.description ?? value['content:encoded']);
    const duration = scalar(value['itunes:duration']);
    return {
      id: guid ?? link ?? sha256(`${title}:${scalar(value.pubDate) ?? index}`).slice(0, 24),
      title,
      ...(link ? { link } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(author ? { author } : {}),
      ...(summary ? { summary } : {}),
      ...(enclosure ? { enclosure } : {}),
      ...(duration ? { duration } : {}),
    };
  });
  return {
    title: plainText(channel.title) ?? 'Untitled feed',
    entries,
    podcast: entries.some((entry) => entry.enclosure?.mimeType?.startsWith('audio/') === true),
  };
}

function parseAtom(root: XmlRecord): { title: string; entries: FeedEntry[]; podcast: boolean } | undefined {
  const feed = record(root.feed);
  if (!feed) return undefined;
  const entries = values(feed.entry).slice(0, MAX_ENTRIES).map((entry, index): FeedEntry => {
    const value = record(entry) ?? {};
    const link = atomLink(value.link);
    const title = plainText(value.title) ?? `Untitled entry ${index + 1}`;
    const publishedAt = normalizeDate(value.published ?? value.updated);
    const author = plainText(record(value.author)?.name);
    const summary = plainText(value.summary ?? value.content);
    return {
      id: scalar(value.id) ?? link ?? sha256(`${title}:${scalar(value.updated) ?? index}`).slice(0, 24),
      title,
      ...(link ? { link } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(author ? { author } : {}),
      ...(summary ? { summary } : {}),
    };
  });
  return { title: plainText(feed.title) ?? 'Untitled feed', entries, podcast: false };
}

export function parseFeed(xml: string): {
  readonly format: 'rss' | 'atom';
  readonly title: string;
  readonly entries: readonly FeedEntry[];
  readonly podcast: boolean;
} {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    processEntities: false,
    trimValues: true,
  }).parse(xml) as unknown;
  const root = record(parsed);
  if (!root) throw new Error('Feed XML must have a document element.');
  const rss = parseRss(root);
  if (rss) return { format: 'rss', ...rss };
  const atom = parseAtom(root);
  if (atom) return { format: 'atom', ...atom };
  throw new Error('The document is neither RSS nor Atom.');
}

function markdownText(value: string): string {
  return value
    .replaceAll(/[\\`*_{}<>]/gu, '\\$&')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}

function feedMarkdown(title: string, entries: readonly FeedEntry[]): string {
  const sections = entries.map((entry) => {
    const heading = `## ${markdownText(entry.title)}`;
    const details = [
      entry.publishedAt ? `- Published: ${entry.publishedAt}` : undefined,
      entry.author ? `- Author: ${markdownText(entry.author)}` : undefined,
      entry.link ? `- Link: ${entry.link}` : undefined,
      entry.enclosure ? `- Media: ${entry.enclosure.url}` : undefined,
      entry.duration ? `- Duration: ${markdownText(entry.duration)}` : undefined,
    ].filter((line): line is string => line !== undefined);
    return [heading, ...details, '', entry.summary ?? ''].join('\n').trimEnd();
  });
  return [`# ${markdownText(title)}`, ...sections].join('\n\n');
}

export class RssSourceConnector implements SourceConnector {
  readonly id = 'org.oldfolio.rss';
  readonly displayName = 'RSS / Atom / Podcast';
  readonly accessMethods = ['open_feed'] as const;
  readonly retentionPolicy = {
    handlesRemoteDeletionSignals: false,
    supportsUserErasure: true,
    defaultRefreshIntervalMs: 60 * 60 * 1_000,
    notes: 'Feed disappearance is not interpreted as a deletion signal.',
  } as const;

  readonly #fetcher: typeof fetch;
  readonly #now: () => Date;
  readonly #urlPolicy: SourceUrlPolicy;

  constructor(options: RssConnectorOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#urlPolicy = options.urlPolicy ?? {};
  }

  probe(input: SourceInput): Promise<SourceProbeResult> {
    if (input.kind !== 'feed') return Promise.resolve({ matched: false, capabilities: [] });
    const url = validateFeedInput(input, this.#urlPolicy);
    return Promise.resolve({
      matched: true,
      canonicalUri: url.toString(),
      capabilities: [
        { capability: 'metadata', availability: 'available', authorization: 'none' },
        { capability: 'content', availability: 'available', authorization: 'none' },
        { capability: 'subscription', availability: 'available', authorization: 'none' },
        { capability: 'captions', availability: 'unsupported', authorization: 'none' },
        { capability: 'comments', availability: 'unsupported', authorization: 'none' },
      ],
    });
  }

  async fetch(request: SourceFetchRequest, context?: OperationContext): Promise<SourceSnapshot> {
    if (request.input.kind !== 'feed') throw new Error('RSS connector requires a feed input.');
    for (const capability of request.capabilities) {
      if (!SUPPORTED.has(capability)) throw new Error(`RSS connector does not support ${capability}.`);
    }
    const response = await fetchBoundedText(
      request.input.url,
      this.#fetcher,
      this.#urlPolicy,
      context?.signal,
    );
    const feed = parseFeed(response.text);
    const fetchedAt = this.#now();
    const contentHash = sha256(response.text);
    const lineageId = `feed-${sha256(response.finalUrl).slice(0, 24)}`;
    return {
      id: `${lineageId}-${contentHash.slice(0, 16)}`,
      connectorId: this.id,
      canonicalUri: response.finalUrl,
      fetchedAt: fetchedAt.toISOString(),
      contentHash,
      title: feed.title,
      mimeType: response.mimeType ?? 'application/xml',
      text: feedMarkdown(feed.title, feed.entries),
      metadata: {
        sourceLineageId: lineageId,
        format: feed.format,
        podcast: feed.podcast,
        entries: feed.entries,
        ...(response.etag ? { etag: response.etag } : {}),
        ...(response.lastModified ? { lastModified: response.lastModified } : {}),
      },
      deletionPolicy: {
        supportsRemoteDeletionSignals: false,
        refreshAfter: new Date(fetchedAt.getTime() + this.retentionPolicy.defaultRefreshIntervalMs).toISOString(),
      },
    };
  }
}

function validateFeedInput(input: Extract<SourceInput, { readonly kind: 'feed' }>, policy: SourceUrlPolicy): URL {
  return validateSourceUrl(input.url, policy);
}
