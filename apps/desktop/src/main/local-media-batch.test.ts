import { describe, expect, it } from 'vitest';

import {
  extractLocalMediaIdentifiers,
  matchLocalMediaFile,
  resolveLocalMediaAssociation,
  type CreatorHistoryCatalog,
} from './local-media-batch.js';

const catalogs: readonly CreatorHistoryCatalog[] = [{
  creatorId: 'creator-0123456789abcdef',
  creatorTitle: '测试博主',
  entries: [
    {
      id: 'yt:video:hL9IDFWyxig',
      title: 'YouTube 历史视频',
      link: 'https://www.youtube.com/watch?v=hL9IDFWyxig',
    },
    {
      id: 'bilibili:BV1V4Kz6SEas',
      title: 'Bilibili 历史视频',
      link: 'https://www.bilibili.com/video/BV1V4Kz6SEas',
    },
    {
      id: 'douyin:video:7460123456789012345',
      title: '抖音历史视频',
      link: 'https://www.douyin.com/video/7460123456789012345',
    },
  ],
}];

describe('local media filename matching', () => {
  it('extracts bracketed YouTube, Bilibili and long numeric platform IDs', () => {
    expect([...extractLocalMediaIdentifiers('标题 [hL9IDFWyxig].mp4')]).toContain('hL9IDFWyxig');
    expect([...extractLocalMediaIdentifiers('标题 BV1V4Kz6SEas.mkv')]).toContain('BV1V4Kz6SEas');
    expect([...extractLocalMediaIdentifiers('作品 7460123456789012345.mp4')]).toContain('7460123456789012345');
  });

  it('suggests an exact creator entry without relying on title similarity', () => {
    const matches = matchLocalMediaFile('下载完成 - YouTube 历史视频 [hL9IDFWyxig].webm', catalogs);

    expect(matches).toEqual([expect.objectContaining({
      creatorId: 'creator-0123456789abcdef',
      creatorEntryId: 'yt:video:hL9IDFWyxig',
      mediaId: 'hL9IDFWyxig',
    })]);
  });

  it('matches Bilibili and Douyin IDs and leaves unrelated filenames personal', () => {
    expect(matchLocalMediaFile('课程 [BV1V4Kz6SEas].mp4', catalogs)[0]?.entryTitle).toBe('Bilibili 历史视频');
    expect(matchLocalMediaFile('抖音备份 7460123456789012345.mp4', catalogs)[0]?.entryTitle).toBe('抖音历史视频');
    expect(matchLocalMediaFile('普通本地会议录像.mp4', catalogs)).toEqual([]);
  });

  it('suggests creator history when a downloaded filename contains only the video title', () => {
    expect(matchLocalMediaFile('YouTube 历史视频.mp4', catalogs)).toEqual([
      expect.objectContaining({
        creatorId: 'creator-0123456789abcdef',
        creatorEntryId: 'yt:video:hL9IDFWyxig',
        matchKind: 'exact-title',
      }),
    ]);
  });

  it('allows a user-confirmed creator without inventing a creator history entry', () => {
    expect(resolveLocalMediaAssociation([], catalogs, 'creator-0123456789abcdef')).toEqual({
      creatorId: 'creator-0123456789abcdef',
      creatorTitle: '测试博主',
    });
  });

  it('rejects renderer-supplied creators and entries outside the authoritative preview', () => {
    expect(() => resolveLocalMediaAssociation([], catalogs, 'creator-ffffffffffffffff')).toThrow('博主');
    expect(() => resolveLocalMediaAssociation(
      matchLocalMediaFile('YouTube 历史视频.mp4', catalogs),
      catalogs,
      'creator-0123456789abcdef',
      'yt:video:not-in-preview',
    )).toThrow('关注记录');
    expect(() => resolveLocalMediaAssociation(
      [],
      catalogs,
      'creator-0123456789abcdef',
      'yt:video:hL9IDFWyxig',
    )).toThrow('关联');
  });
});
