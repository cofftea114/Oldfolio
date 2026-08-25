import { createHash } from 'node:crypto';

import type { SourceSnapshot } from '@oldfolio/domain';
import { compileSourceDocument } from '@oldfolio/ingest';
import type { RssSourceConnector } from '@oldfolio/ingest';
import { serializeNewOkfConcept } from '@oldfolio/okf';
import { VaultNotFoundError, type VaultRepository } from '@oldfolio/vault';

const CONFIG_PATH = '.oldfolio/config/creator-subscriptions.json';
const REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
const MAX_SUBSCRIPTIONS = 500;
const MAX_ENTRY_IDS = 2_000;
const MAX_ENTRY_TITLE = 1_000;

interface StoredCreatorSubscription {
  readonly id: string;
  readonly title: string;
  readonly feedUrl: string;
  readonly creatorDocumentPath: string;
  readonly addedAt: string;
  readonly lastCheckedAt: string;
  readonly nextCheckAt: string;
  readonly lastContentHash: string;
  readonly lastSnapshotId: string;
  readonly knownEntryIds: readonly string[];
  readonly entries: readonly CreatorFeedEntrySummary[];
  readonly lastNewEntryCount: number;
  readonly historySource?: 'youtube_data_api';
  readonly historyFetchedAt?: string;
  readonly historyComplete?: boolean;
  readonly historyTotalResults?: number;
  readonly lastError?: string;
}

interface CreatorSubscriptionFile {
  readonly version: 1;
  readonly subscriptions: readonly StoredCreatorSubscription[];
}

export interface CreatorSubscriptionSummary {
  readonly id: string;
  readonly title: string;
  readonly feedUrl: string;
  readonly creatorDocumentPath: string;
  readonly addedAt: string;
  readonly lastCheckedAt: string;
  readonly nextCheckAt: string;
  readonly lastSnapshotId: string;
  readonly lastNewEntryCount: number;
  readonly entryCount: number;
  readonly historySource: 'feed' | 'youtube_data_api';
  readonly historyFetchedAt?: string;
  readonly historyComplete?: boolean;
  readonly historyTotalResults?: number;
  readonly lastError?: string;
}

export interface CreatorFeedEntrySummary {
  readonly id: string;
  readonly title: string;
  readonly link?: string;
  readonly publishedAt?: string;
  readonly author?: string;
  readonly mediaUrl?: string;
  readonly mediaType?: string;
  readonly duration?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown feed refresh failure';
  return message.replaceAll(/[\r\n\0]+/gu, ' ').trim().slice(0, 500) || 'Unknown feed refresh failure';
}

function optionalBoundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function optionalRemoteUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4_096) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function validateFeedEntry(value: unknown): CreatorFeedEntrySummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('历史内容记录无效。');
  const entry = value as Partial<CreatorFeedEntrySummary>;
  if (
    typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 4_096
    || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > MAX_ENTRY_TITLE
    || (entry.publishedAt !== undefined && !validDate(entry.publishedAt))
  ) throw new Error('历史内容记录无效。');
  const link = optionalRemoteUrl(entry.link);
  const mediaUrl = optionalRemoteUrl(entry.mediaUrl);
  const author = optionalBoundedString(entry.author, 1_000);
  const mediaType = optionalBoundedString(entry.mediaType, 256);
  const duration = optionalBoundedString(entry.duration, 128);
  return {
    id: entry.id.trim(),
    title: entry.title.trim(),
    ...(link ? { link } : {}),
    ...(entry.publishedAt ? { publishedAt: entry.publishedAt } : {}),
    ...(author ? { author } : {}),
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(duration ? { duration } : {}),
  };
}

function feedEntries(metadata: Readonly<Record<string, unknown>>): readonly CreatorFeedEntrySummary[] {
  if (!Array.isArray(metadata.entries)) return [];
  const entries: CreatorFeedEntrySummary[] = [];
  for (const entry of metadata.entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const source = entry as Record<string, unknown>;
    const id = optionalBoundedString(source.id, 4_096);
    const title = optionalBoundedString(source.title, MAX_ENTRY_TITLE);
    if (!id || !title) continue;
    const enclosure = typeof source.enclosure === 'object' && source.enclosure !== null && !Array.isArray(source.enclosure)
      ? source.enclosure as Record<string, unknown>
      : undefined;
    entries.push(validateFeedEntry({
      id,
      title,
      link: source.link,
      publishedAt: source.publishedAt,
      author: source.author,
      mediaUrl: enclosure?.url,
      mediaType: enclosure?.mimeType,
      duration: source.duration,
    }));
    if (entries.length >= MAX_ENTRY_IDS) break;
  }
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

function mergeEntries(
  existing: readonly CreatorFeedEntrySummary[],
  incoming: readonly CreatorFeedEntrySummary[],
): readonly CreatorFeedEntrySummary[] {
  const merged = new Map(incoming.map((entry) => [entry.id, entry]));
  for (const entry of existing) {
    if (!merged.has(entry.id)) merged.set(entry.id, entry);
  }
  return [...merged.values()].sort((left, right) => {
    const leftTime = Date.parse(left.publishedAt ?? '');
    const rightTime = Date.parse(right.publishedAt ?? '');
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime;
    if (Number.isFinite(leftTime)) return -1;
    if (Number.isFinite(rightTime)) return 1;
    return 0;
  }).slice(0, MAX_ENTRY_IDS);
}

function validateSubscription(value: unknown): StoredCreatorSubscription {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('关注记录无效。');
  const item = value as Partial<StoredCreatorSubscription>;
  const lastNewEntryCount = item.lastNewEntryCount;
  const entries = item.entries === undefined
    ? []
    : Array.isArray(item.entries) && item.entries.length <= MAX_ENTRY_IDS
      ? item.entries.map(validateFeedEntry)
      : undefined;
  if (
    typeof item.id !== 'string' || !/^creator-[a-f0-9]{16}$/u.test(item.id)
    || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 500
    || typeof item.feedUrl !== 'string' || item.feedUrl.length > 4_096
    || item.creatorDocumentPath !== `bundles/creators/${item.id}/wiki/creator.md`
    || !validDate(item.addedAt) || !validDate(item.lastCheckedAt) || !validDate(item.nextCheckAt)
    || typeof item.lastContentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(item.lastContentHash)
    || typeof item.lastSnapshotId !== 'string' || !item.lastSnapshotId
    || !Array.isArray(item.knownEntryIds) || item.knownEntryIds.length > MAX_ENTRY_IDS
    || item.knownEntryIds.some((id) => typeof id !== 'string' || !id || id.length > 4_096)
    || !Number.isSafeInteger(lastNewEntryCount) || lastNewEntryCount === undefined || lastNewEntryCount < 0
    || entries === undefined
    || (item.historySource !== undefined && item.historySource !== 'youtube_data_api')
    || (item.historyFetchedAt !== undefined && !validDate(item.historyFetchedAt))
    || (item.historyComplete !== undefined && typeof item.historyComplete !== 'boolean')
    || (item.historyTotalResults !== undefined && (!Number.isSafeInteger(item.historyTotalResults) || item.historyTotalResults < 0))
    || (item.lastError !== undefined && (typeof item.lastError !== 'string' || item.lastError.length > 500))
  ) throw new Error('关注记录无效。');
  return {
    id: item.id,
    title: item.title.trim(),
    feedUrl: new URL(item.feedUrl).toString(),
    creatorDocumentPath: item.creatorDocumentPath,
    addedAt: item.addedAt,
    lastCheckedAt: item.lastCheckedAt,
    nextCheckAt: item.nextCheckAt,
    lastContentHash: item.lastContentHash,
    lastSnapshotId: item.lastSnapshotId,
    knownEntryIds: [...new Set(item.knownEntryIds)],
    entries,
    lastNewEntryCount,
    ...(item.historySource ? { historySource: item.historySource } : {}),
    ...(item.historyFetchedAt ? { historyFetchedAt: item.historyFetchedAt } : {}),
    ...(item.historyComplete === undefined ? {} : { historyComplete: item.historyComplete }),
    ...(item.historyTotalResults === undefined ? {} : { historyTotalResults: item.historyTotalResults }),
    ...(item.lastError ? { lastError: item.lastError } : {}),
  };
}

function parseFile(source: string): CreatorSubscriptionFile {
  const value = JSON.parse(source) as { readonly version?: unknown; readonly subscriptions?: unknown };
  if (value.version !== 1 || !Array.isArray(value.subscriptions) || value.subscriptions.length > MAX_SUBSCRIPTIONS) {
    throw new Error('关注配置无效。');
  }
  const subscriptions = value.subscriptions.map(validateSubscription);
  if (new Set(subscriptions.map((item) => item.id)).size !== subscriptions.length) throw new Error('关注记录重复。');
  return { version: 1, subscriptions };
}

function summary(item: StoredCreatorSubscription): CreatorSubscriptionSummary {
  return {
    id: item.id,
    title: item.title,
    feedUrl: item.feedUrl,
    creatorDocumentPath: item.creatorDocumentPath,
    addedAt: item.addedAt,
    lastCheckedAt: item.lastCheckedAt,
    nextCheckAt: item.nextCheckAt,
    lastSnapshotId: item.lastSnapshotId,
    lastNewEntryCount: item.lastNewEntryCount,
    entryCount: item.entries.length,
    historySource: item.historySource ?? 'feed',
    ...(item.historyFetchedAt ? { historyFetchedAt: item.historyFetchedAt } : {}),
    ...(item.historyComplete === undefined ? {} : { historyComplete: item.historyComplete }),
    ...(item.historyTotalResults === undefined ? {} : { historyTotalResults: item.historyTotalResults }),
    ...(item.lastError ? { lastError: item.lastError } : {}),
  };
}

function creatorDocument(item: StoredCreatorSubscription, fetchedAt: string): string {
  return serializeNewOkfConcept({
    frontmatter: {
      type: 'Creator',
      title: item.title,
      description: 'Creator profile maintained from an explicitly followed open feed.',
      resource: item.feedUrl,
      status: 'stable',
      generated: { by: 'connector:org.oldfolio.rss', at: fetchedAt },
      oldfolio: {
        id: item.id,
        feed_url: item.feedUrl,
        added_at: item.addedAt,
      },
    },
    body: `# ${item.title.replaceAll(/[\\`*_{}<>#]/gu, '\\$&').replaceAll('[', '\\[').replaceAll(']', '\\]')}\n\n- Feed: ${item.feedUrl}\n- Followed: ${item.addedAt}\n`,
  });
}

export class CreatorTrackerService {
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: VaultRepository,
    private readonly connector: RssSourceConnector,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): Promise<readonly CreatorSubscriptionSummary[]> {
    return this.run(async () => (await this.load()).subscriptions
      .map(summary)
      .sort((left, right) => left.title.localeCompare(right.title)));
  }

  follow(feedUrl: string): Promise<CreatorSubscriptionSummary> {
    return this.run(async () => {
      const snapshot = await this.connector.fetch({
        input: { kind: 'feed', url: feedUrl.trim() },
        capabilities: ['metadata', 'content', 'subscription'],
      });
      const current = await this.load();
      const existing = current.subscriptions.find((item) => item.feedUrl === snapshot.canonicalUri);
      if (existing) return this.refreshSubscription(existing, current);
      if (current.subscriptions.length >= MAX_SUBSCRIPTIONS) throw new Error('关注数量已达到 500 个上限。');
      const checkedAt = this.now().toISOString();
      const id = `creator-${sha256(snapshot.canonicalUri).slice(0, 16)}`;
      const entries = feedEntries(snapshot.metadata);
      const item: StoredCreatorSubscription = {
        id,
        title: snapshot.title?.trim() || new URL(snapshot.canonicalUri).hostname,
        feedUrl: snapshot.canonicalUri,
        creatorDocumentPath: `bundles/creators/${id}/wiki/creator.md`,
        addedAt: checkedAt,
        lastCheckedAt: checkedAt,
        nextCheckAt: new Date(this.now().getTime() + REFRESH_INTERVAL_MS).toISOString(),
        lastContentHash: snapshot.contentHash,
        lastSnapshotId: snapshot.id,
        knownEntryIds: entries.map((entry) => entry.id),
        entries,
        lastNewEntryCount: 0,
      };
      await this.ensureBundle(item, snapshot.fetchedAt);
      await this.saveSnapshot(item.id, snapshot);
      await this.appendLog(item.id, checkedAt, `开始关注；保存来源快照 ${snapshot.id}`);
      await this.save({ version: 1, subscriptions: [...current.subscriptions, item] });
      return summary(item);
    });
  }

  refresh(id: string): Promise<CreatorSubscriptionSummary> {
    return this.run(async () => {
      const current = await this.load();
      const item = current.subscriptions.find((candidate) => candidate.id === id);
      if (!item) throw new Error('未找到该关注。');
      return this.refreshSubscription(item, current);
    });
  }

  refreshDue(): Promise<readonly CreatorSubscriptionSummary[]> {
    return this.run(async () => {
      let current = await this.load();
      const results: CreatorSubscriptionSummary[] = [];
      const dueIds = current.subscriptions
        .filter((item) => Date.parse(item.nextCheckAt) <= this.now().getTime())
        .map((item) => item.id);
      for (const id of dueIds) {
        const item = current.subscriptions.find((candidate) => candidate.id === id);
        if (!item) continue;
        results.push(await this.refreshSubscription(item, current));
        current = await this.load();
      }
      return results;
    });
  }

  refreshAll(): Promise<readonly CreatorSubscriptionSummary[]> {
    return this.run(async () => {
      let current = await this.load();
      const results: CreatorSubscriptionSummary[] = [];
      for (const id of current.subscriptions.map((item) => item.id)) {
        const item = current.subscriptions.find((candidate) => candidate.id === id);
        if (!item) continue;
        results.push(await this.refreshSubscription(item, current));
        current = await this.load();
      }
      return results;
    });
  }

  history(id: string): Promise<readonly CreatorFeedEntrySummary[]> {
    return this.run(async () => {
      let current = await this.load();
      let item = current.subscriptions.find((candidate) => candidate.id === id);
      if (!item) throw new Error('未找到该关注。');
      if (item.entries.length === 0 && item.knownEntryIds.length > 0) {
        await this.refreshSubscription(item, current);
        current = await this.load();
        item = current.subscriptions.find((candidate) => candidate.id === id);
        if (!item) throw new Error('未找到该关注。');
      }
      return [...item.entries].sort((left, right) => {
        const leftTime = Date.parse(left.publishedAt ?? '');
        const rightTime = Date.parse(right.publishedAt ?? '');
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime;
        if (Number.isFinite(leftTime)) return -1;
        if (Number.isFinite(rightTime)) return 1;
        return 0;
      });
    });
  }

  importOfficialHistory(id: string, snapshot: SourceSnapshot): Promise<CreatorSubscriptionSummary> {
    return this.run(async () => {
      if (snapshot.connectorId !== 'org.oldfolio.youtube-data-api') throw new Error('该来源不是 YouTube Data API 历史快照。');
      const current = await this.load();
      const item = current.subscriptions.find((candidate) => candidate.id === id);
      if (!item) throw new Error('未找到该关注。');
      const incoming = feedEntries(snapshot.metadata);
      const known = new Set(item.knownEntryIds);
      const newEntryCount = incoming.filter((entry) => !known.has(entry.id)).length;
      const entries = mergeEntries(item.entries, incoming);
      const historyTotalResults = Number(snapshot.metadata.totalResults);
      const updated: StoredCreatorSubscription = {
        id: item.id,
        title: item.title,
        feedUrl: item.feedUrl,
        creatorDocumentPath: item.creatorDocumentPath,
        addedAt: item.addedAt,
        lastCheckedAt: item.lastCheckedAt,
        nextCheckAt: item.nextCheckAt,
        lastContentHash: item.lastContentHash,
        lastSnapshotId: item.lastSnapshotId,
        knownEntryIds: entries.map((entry) => entry.id),
        entries,
        lastNewEntryCount: newEntryCount,
        historySource: 'youtube_data_api',
        historyFetchedAt: snapshot.fetchedAt,
        historyComplete: snapshot.metadata.complete === true,
        ...(Number.isSafeInteger(historyTotalResults) && historyTotalResults >= 0 ? { historyTotalResults } : {}),
      };
      await this.saveSnapshot(item.id, snapshot);
      await this.appendLog(
        item.id,
        snapshot.fetchedAt,
        `通过 YouTube Data API 导入 ${incoming.length} 条历史内容；新增 ${newEntryCount} 条；保存来源快照 ${snapshot.id}`,
      );
      await this.replaceAndSave(current, updated);
      return summary(updated);
    });
  }

  remove(id: string): Promise<readonly CreatorSubscriptionSummary[]> {
    return this.run(async () => {
      const current = await this.load();
      const subscriptions = current.subscriptions.filter((item) => item.id !== id);
      if (subscriptions.length === current.subscriptions.length) throw new Error('未找到该关注。');
      await this.save({ version: 1, subscriptions });
      return subscriptions.map(summary).sort((left, right) => left.title.localeCompare(right.title));
    });
  }

  private async refreshSubscription(
    item: StoredCreatorSubscription,
    current: CreatorSubscriptionFile,
  ): Promise<CreatorSubscriptionSummary> {
    const checkedAt = this.now().toISOString();
    try {
      const snapshot = await this.connector.fetch({
        input: { kind: 'feed', url: item.feedUrl },
        capabilities: ['metadata', 'content', 'subscription'],
      });
      const feedHistory = feedEntries(snapshot.metadata);
      const ids = feedHistory.map((entry) => entry.id);
      const known = new Set(item.knownEntryIds);
      const newEntryCount = ids.filter((id) => !known.has(id)).length;
      const entries = mergeEntries(item.entries, feedHistory);
      const changed = snapshot.contentHash !== item.lastContentHash;
      if (changed) {
        await this.saveSnapshot(item.id, snapshot);
        await this.appendLog(item.id, checkedAt, `发现 ${newEntryCount} 条新内容；保存来源快照 ${snapshot.id}`);
      }
      const updated: StoredCreatorSubscription = {
        id: item.id,
        title: snapshot.title?.trim() || item.title,
        feedUrl: snapshot.canonicalUri,
        creatorDocumentPath: item.creatorDocumentPath,
        addedAt: item.addedAt,
        lastCheckedAt: checkedAt,
        nextCheckAt: new Date(this.now().getTime() + REFRESH_INTERVAL_MS).toISOString(),
        lastContentHash: snapshot.contentHash,
        lastSnapshotId: snapshot.id,
        knownEntryIds: entries.map((entry) => entry.id),
        entries,
        lastNewEntryCount: changed ? newEntryCount : 0,
        ...(item.historySource ? { historySource: item.historySource } : {}),
        ...(item.historyFetchedAt ? { historyFetchedAt: item.historyFetchedAt } : {}),
        ...(item.historyComplete === undefined ? {} : { historyComplete: item.historyComplete }),
        ...(item.historyTotalResults === undefined ? {} : { historyTotalResults: item.historyTotalResults }),
      };
      await this.replaceAndSave(current, updated);
      return summary(updated);
    } catch (error) {
      const failed: StoredCreatorSubscription = {
        ...item,
        lastCheckedAt: checkedAt,
        nextCheckAt: new Date(this.now().getTime() + REFRESH_INTERVAL_MS).toISOString(),
        lastNewEntryCount: 0,
        lastError: normalizeError(error),
      };
      await this.replaceAndSave(current, failed);
      return summary(failed);
    }
  }

  private async ensureBundle(item: StoredCreatorSubscription, fetchedAt: string): Promise<void> {
    await this.writeIfMissing(`bundles/creators/${item.id}/index.md`, [
      '---', 'okf_version: "0.2"', '---', '', `# ${item.title}`, '', '- [[wiki/creator|Creator profile]]', '',
    ].join('\n'));
    await this.writeIfMissing(`bundles/creators/${item.id}/log.md`, '# Change log\n');
    await this.writeIfMissing(item.creatorDocumentPath, creatorDocument(item, fetchedAt));
  }

  private async saveSnapshot(id: string, snapshot: SourceSnapshot): Promise<void> {
    const document = compileSourceDocument(snapshot, { bundleRoot: `bundles/creators/${id}` });
    await this.writeIfMissing(document.path, document.content);
  }

  private async appendLog(id: string, at: string, message: string): Promise<void> {
    const path = `bundles/creators/${id}/log.md`;
    const current = await this.repository.read(path);
    await this.repository.write(path, `${current.text.trimEnd()}\n\n- ${at} — ${message}\n`, current.revision);
  }

  private async writeIfMissing(path: string, content: string): Promise<void> {
    try {
      const existing = await this.repository.read(path);
      if (existing.text !== content) return;
    } catch (error) {
      if (!(error instanceof VaultNotFoundError)) throw error;
      await this.repository.write(path, content, null);
    }
  }

  private async replaceAndSave(current: CreatorSubscriptionFile, updated: StoredCreatorSubscription): Promise<void> {
    await this.save({
      version: 1,
      subscriptions: current.subscriptions.map((item) => item.id === updated.id ? updated : item),
    });
  }

  private async load(): Promise<CreatorSubscriptionFile> {
    try {
      return parseFile((await this.repository.read(CONFIG_PATH)).text);
    } catch (error) {
      if (error instanceof VaultNotFoundError) return { version: 1, subscriptions: [] };
      throw error;
    }
  }

  private async save(file: CreatorSubscriptionFile): Promise<void> {
    const content = `${JSON.stringify(file, null, 2)}\n`;
    try {
      const existing = await this.repository.read(CONFIG_PATH);
      await this.repository.write(CONFIG_PATH, content, existing.revision);
    } catch (error) {
      if (!(error instanceof VaultNotFoundError)) throw error;
      await this.repository.write(CONFIG_PATH, content, null);
    }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
