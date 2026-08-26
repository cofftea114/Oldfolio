import { extname } from 'node:path';

import type { CreatorFeedEntrySummary } from './creator-tracker.js';

export interface CreatorHistoryCatalog {
  readonly creatorId: string;
  readonly creatorTitle: string;
  readonly entries: readonly CreatorFeedEntrySummary[];
}

export interface LocalMediaCreatorMatch {
  readonly creatorId: string;
  readonly creatorTitle: string;
  readonly creatorEntryId: string;
  readonly entryTitle: string;
  readonly mediaId?: string;
  readonly matchKind: 'platform-id' | 'exact-title';
  readonly sourceUrl?: string;
}

export interface LocalMediaAssociation {
  readonly creatorId: string;
  readonly creatorTitle: string;
  readonly creatorEntryId?: string;
  readonly entryTitle?: string;
  readonly sourceUrl?: string;
}

function normalizedMediaTitle(value: string): string {
  const extension = extname(value);
  return value
    .slice(0, Math.max(0, value.length - extension.length))
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/\[(?:[A-Za-z0-9_-]{6,64}|BV[0-9A-Za-z]{10})\]/gu, ' ')
    .replace(/(?:[\s_-]*(?:哔哩哔哩|bilibili|youtube|抖音|douyin))+$/gu, ' ')
    .replaceAll(/[\p{P}\p{S}\s]+/gu, '');
}

const BRACKETED_ID = /\[([A-Za-z0-9_-]{6,64})\]/gu;
const BILIBILI_ID = /(?:^|[^A-Za-z0-9])(BV[0-9A-Za-z]{10})(?=$|[^A-Za-z0-9])/gu;
const SEPARATED_YOUTUBE_ID = /(?:^|[\s_.()[\]-])([A-Za-z0-9_-]{11})(?=$|[\s_.()[\]-])/gu;
const LONG_NUMERIC_ID = /(?:^|\D)([0-9]{15,22})(?=\D|$)/gu;

function addMatches(pattern: RegExp, value: string, group: number, target: Set<string>): void {
  pattern.lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    const id = match[group];
    if (id) target.add(id);
  }
}

/** Extracts only filename-safe platform IDs; arbitrary title words are deliberately ignored. */
export function extractLocalMediaIdentifiers(value: string): ReadonlySet<string> {
  const withoutExtension = value.slice(0, Math.max(0, value.length - extname(value).length));
  const identifiers = new Set<string>();
  addMatches(BRACKETED_ID, withoutExtension, 1, identifiers);
  addMatches(BILIBILI_ID, withoutExtension, 1, identifiers);
  addMatches(SEPARATED_YOUTUBE_ID, withoutExtension, 1, identifiers);
  addMatches(LONG_NUMERIC_ID, withoutExtension, 1, identifiers);
  return identifiers;
}

function entryIdentifiers(entry: CreatorFeedEntrySummary): ReadonlySet<string> {
  const identifiers = new Set<string>();
  const youtubeEntry = /^(?:yt|youtube):video:([A-Za-z0-9_-]{6,64})$/u.exec(entry.id)?.[1];
  if (youtubeEntry) identifiers.add(youtubeEntry);
  const bilibiliEntry = /(BV[0-9A-Za-z]{10})/u.exec(entry.id)?.[1];
  if (bilibiliEntry) identifiers.add(bilibiliEntry);
  const numericEntry = /(?:^|:)([0-9]{15,22})$/u.exec(entry.id)?.[1];
  if (numericEntry) identifiers.add(numericEntry);

  for (const source of [entry.link, entry.mediaUrl]) {
    if (!source) continue;
    try {
      const url = new URL(source);
      if (url.hostname === 'youtu.be') {
        const id = url.pathname.split('/').filter(Boolean)[0];
        if (id) identifiers.add(id);
      }
      const youtubeId = url.searchParams.get('v');
      if (youtubeId) identifiers.add(youtubeId);
      const bilibiliId = /(BV[0-9A-Za-z]{10})/u.exec(url.pathname)?.[1];
      if (bilibiliId) identifiers.add(bilibiliId);
      const numericId = /(?:video|note)\/([0-9]{15,22})/u.exec(url.pathname)?.[1];
      if (numericId) identifiers.add(numericId);
    } catch {
      // Invalid remote URLs are already filtered by the creator store. Ignore defensive parse failures.
    }
  }
  return identifiers;
}

export function matchLocalMediaFile(
  fileName: string,
  catalogs: readonly CreatorHistoryCatalog[],
): readonly LocalMediaCreatorMatch[] {
  const fileIdentifiers = extractLocalMediaIdentifiers(fileName);
  const fileTitle = normalizedMediaTitle(fileName);
  const matches = new Map<string, LocalMediaCreatorMatch>();
  for (const catalog of catalogs) {
    for (const entry of catalog.entries) {
      const mediaId = [...entryIdentifiers(entry)].find((id) => fileIdentifiers.has(id));
      const exactTitle = fileTitle.length >= 4 && fileTitle === normalizedMediaTitle(entry.title);
      if (!mediaId && !exactTitle) continue;
      const key = `${catalog.creatorId}\0${entry.id}`;
      const candidate: LocalMediaCreatorMatch = {
        creatorId: catalog.creatorId,
        creatorTitle: catalog.creatorTitle,
        creatorEntryId: entry.id,
        entryTitle: entry.title,
        matchKind: mediaId ? 'platform-id' : 'exact-title',
        ...(mediaId ? { mediaId } : {}),
        ...((entry.mediaUrl ?? entry.link) ? { sourceUrl: entry.mediaUrl ?? entry.link } : {}),
      };
      const current = matches.get(key);
      if (!current || candidate.matchKind === 'platform-id') matches.set(key, candidate);
    }
  }
  return [...matches.values()].sort((left, right) => (
    (left.matchKind === right.matchKind ? 0 : left.matchKind === 'platform-id' ? -1 : 1)
    ||
    left.creatorTitle.localeCompare(right.creatorTitle)
    || left.entryTitle.localeCompare(right.entryTitle)
    || left.creatorEntryId.localeCompare(right.creatorEntryId)
  ));
}

/** Resolves renderer input against the creator catalog and item-specific preview matches. */
export function resolveLocalMediaAssociation(
  itemMatches: readonly LocalMediaCreatorMatch[],
  catalogs: readonly CreatorHistoryCatalog[],
  creatorId: string,
  creatorEntryId?: string,
): LocalMediaAssociation {
  const creator = catalogs.find((catalog) => catalog.creatorId === creatorId);
  if (!creator) throw new Error('所选博主不在当前关注列表中。');
  if (!creatorEntryId) return { creatorId: creator.creatorId, creatorTitle: creator.creatorTitle };
  if (!creator.entries.some((entry) => entry.id === creatorEntryId)) {
    throw new Error('所选博主历史条目已不在当前关注记录中。');
  }
  const match = itemMatches.find((candidate) => (
    candidate.creatorId === creatorId && candidate.creatorEntryId === creatorEntryId
  ));
  if (!match) throw new Error('批量媒体的博主条目关联与预览结果不一致。');
  return {
    creatorId: match.creatorId,
    creatorTitle: match.creatorTitle,
    creatorEntryId: match.creatorEntryId,
    entryTitle: match.entryTitle,
    ...(match.sourceUrl ? { sourceUrl: match.sourceUrl } : {}),
  };
}
