import { describe, expect, it, vi } from 'vitest';

import { YouTubeDataApiConnector, YouTubeDataApiError } from './youtube-data-api.js';

const CHANNEL_ID = 'UCvijahEyGtvMpmMHBu4FS2w';
const UPLOADS_ID = 'UUvijahEyGtvMpmMHBu4FS2w';
const SECRET_REF = 'youtube:data-api';
const context = {
  resolveSecret: () => Promise.resolve('test-api-key'),
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function channelResponse(): Response {
  return json({
    items: [{
      id: CHANNEL_ID,
      snippet: { title: '零度解说' },
      contentDetails: { relatedPlaylists: { uploads: UPLOADS_ID } },
    }],
  });
}

describe('YouTube Data API connector', () => {
  it('resolves a handle without placing the API key in the URL', async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
      expect(url.origin).toBe('https://www.googleapis.com');
      expect(url.pathname).toBe('/youtube/v3/channels');
      expect(url.searchParams.get('forHandle')).toBe('@lingdujieshuo');
      expect(url.href).not.toContain('test-api-key');
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('test-api-key');
      return Promise.resolve(channelResponse());
    });
    const connector = new YouTubeDataApiConnector({ fetcher });
    await expect(connector.resolveChannel(
      { kind: 'url', url: 'https://www.youtube.com/@lingdujieshuo' },
      SECRET_REF,
      context,
    )).resolves.toMatchObject({
      id: CHANNEL_ID,
      title: '零度解说',
      uploadsPlaylistId: UPLOADS_ID,
      feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    });
  });

  it('paginates the uploads playlist and produces an immutable source snapshot', async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
      if (url.pathname.endsWith('/channels')) return Promise.resolve(channelResponse());
      const secondPage = url.searchParams.get('pageToken') === 'next-page';
      return Promise.resolve(json(secondPage ? {
        pageInfo: { totalResults: 2 },
        items: [{
          contentDetails: { videoId: 'video-1' },
          snippet: { title: 'Older video', publishedAt: '2026-08-01T00:00:00Z', channelTitle: '零度解说' },
          status: { privacyStatus: 'public' },
        }],
      } : {
        nextPageToken: 'next-page',
        pageInfo: { totalResults: 2 },
        items: [
          {
            contentDetails: { videoId: 'video-2' },
            snippet: { title: 'Newest video', publishedAt: '2026-08-20T00:00:00Z', channelTitle: '零度解说' },
            status: { privacyStatus: 'public' },
          },
          {
            contentDetails: { videoId: 'private-video' },
            snippet: { title: 'Private video' },
            status: { privacyStatus: 'private' },
          },
        ],
      }));
    });
    const connector = new YouTubeDataApiConnector({
      fetcher,
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    });
    const snapshot = await connector.fetch({
      input: { kind: 'url', url: `https://www.youtube.com/channel/${CHANNEL_ID}` },
      capabilities: ['metadata', 'content', 'subscription'],
      secretRef: SECRET_REF,
    }, context);
    expect(snapshot).toMatchObject({
      connectorId: 'org.oldfolio.youtube-data-api',
      canonicalUri: `https://www.youtube.com/channel/${CHANNEL_ID}`,
      title: '零度解说 — YouTube uploads',
      metadata: { complete: true, pageCount: 2, totalResults: 2 },
    });
    expect(snapshot.metadata.entries).toMatchObject([
      { id: 'yt:video:video-2', title: 'Newest video' },
      { id: 'yt:video:video-1', title: 'Older video' },
    ]);
    expect(snapshot.text).toContain('Newest video');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('maps API failures without exposing the API key', async () => {
    const connector = new YouTubeDataApiConnector({
      fetcher: () => Promise.resolve(json({
        error: { message: 'Daily quota exhausted', errors: [{ reason: 'quotaExceeded' }] },
      }, 403)),
    });
    const failure = connector.resolveChannel(
      { kind: 'url', url: 'https://www.youtube.com/@lingdujieshuo' },
      SECRET_REF,
      context,
    );
    await expect(failure).rejects.toBeInstanceOf(YouTubeDataApiError);
    await expect(failure).rejects.not.toThrow(/test-api-key/u);
    await expect(failure).rejects.toThrow(/quotaExceeded/u);
  });

  it('requires a controlled secret reference', async () => {
    const connector = new YouTubeDataApiConnector({ fetcher: vi.fn() });
    await expect(connector.resolveChannel(
      { kind: 'url', url: 'https://www.youtube.com/@lingdujieshuo' },
      SECRET_REF,
      { resolveSecret: () => Promise.resolve(undefined) },
    )).rejects.toThrow(/没有可用/u);
  });
});
