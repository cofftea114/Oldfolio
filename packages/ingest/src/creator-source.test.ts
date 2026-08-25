import { describe, expect, it, vi } from 'vitest';

import { CreatorSourceResolver, discoverFeedLinks, discoverYoutubeChannelId } from './creator-source.js';

const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><title>Creator Feed</title><item><guid>1</guid><title>One</title></item></channel></rss>';
const YOUTUBE_ATOM = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>YouTube Creator</title><entry><id>yt:video:1</id><title>One</title><link href="https://www.youtube.com/watch?v=1"/></entry></feed>';
const CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';

describe('creator source resolution', () => {
  it('recognizes a direct RSS URL', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(RSS, {
      status: 200, headers: { 'content-type': 'application/rss+xml' },
    })));
    const result = await new CreatorSourceResolver({ fetcher }).resolve('https://example.com/feed.xml');
    expect(result).toMatchObject({
      status: 'ready', method: 'direct_feed', feedUrl: 'https://example.com/feed.xml', title: 'Creator Feed', entryCount: 1,
    });
  });

  it('discovers and validates an alternate feed declared by a homepage', async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(url.includes('/feed.xml?')
        ? new Response(RSS, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
        : new Response('<html><head><link REL="alternate" type="application/rss+xml" href="/feed.xml?creator=1&amp;format=full"></head></html>', {
            status: 200, headers: { 'content-type': 'text/html' },
          }));
    });
    const result = await new CreatorSourceResolver({ fetcher }).resolve('https://example.com/creator');
    expect(result).toMatchObject({
      status: 'ready', method: 'homepage_feed', title: 'Creator Feed',
      feedUrl: 'https://example.com/feed.xml?creator=1&format=full',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('requires an approved official connector for platform homepages without a feed', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('blocked', { status: 403 })));
    await expect(new CreatorSourceResolver({ fetcher }).resolve('https://space.bilibili.com/123')).resolves.toMatchObject({
      platform: 'bilibili', status: 'official_api_required', method: 'official_api', authorization: 'api_key_or_oauth',
    });
  });

  it('derives and validates the public feed from a YouTube channel URL', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(YOUTUBE_ATOM, {
      status: 200, headers: { 'content-type': 'application/atom+xml' },
    })));
    const result = await new CreatorSourceResolver({ fetcher }).resolve(`https://www.youtube.com/channel/${CHANNEL_ID}`);
    expect(result).toMatchObject({
      platform: 'youtube', status: 'ready', method: 'platform_feed', title: 'YouTube Creator', entryCount: 1,
      feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    });
    expect(result.message).toContain('Feed 不保证完整历史');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('derives a YouTube feed from declarative channel metadata on a handle page', async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(url.includes('/feeds/videos.xml')
        ? new Response(YOUTUBE_ATOM, { status: 200, headers: { 'content-type': 'application/atom+xml' } })
        : new Response(`<html><head><meta itemprop="channelId" content="${CHANNEL_ID}"></head></html>`, {
            status: 200, headers: { 'content-type': 'text/html' },
          }));
    });
    const result = await new CreatorSourceResolver({ fetcher }).resolve('https://www.youtube.com/@googledevelopers');
    expect(result).toMatchObject({ status: 'ready', method: 'platform_feed', title: 'YouTube Creator' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('discovers a YouTube feed when the homepage is larger than the bounded metadata prefix', async () => {
    const homepage = `<html><head><link rel="alternate" type="application/rss+xml" href="https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}"></head>${'x'.repeat(2_200_000)}</html>`;
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(url.includes('/feeds/videos.xml')
        ? new Response(YOUTUBE_ATOM, { status: 200, headers: { 'content-type': 'application/atom+xml' } })
        : new Response(homepage, {
            status: 200,
            headers: { 'content-type': 'text/html', 'content-length': String(homepage.length) },
          }));
    });
    const result = await new CreatorSourceResolver({ fetcher }).resolve('https://www.youtube.com/@large-page');
    expect(result).toMatchObject({ status: 'ready', method: 'homepage_feed', title: 'YouTube Creator' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('can read a YouTube channel ID from canonical or Open Graph metadata', () => {
    expect(discoverYoutubeChannelId(
      `<link rel="canonical" href="/channel/${CHANNEL_ID}">`,
      'https://www.youtube.com/@googledevelopers',
    )).toBe(CHANNEL_ID);
    expect(discoverYoutubeChannelId(
      `<meta property="og:url" content="https://www.youtube.com/channel/${CHANNEL_ID}">`,
      'https://www.youtube.com/@googledevelopers',
    )).toBe(CHANNEL_ID);
  });

  it('does not treat scripts or non-http alternate links as feeds', () => {
    const html = [
      '<script>document.write(`<link rel="alternate" href="https://evil.example/feed">`)</script>',
      '<link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">',
    ].join('');
    expect(discoverFeedLinks(html, 'https://example.com')).toEqual([]);
    expect(discoverYoutubeChannelId(
      `<script><meta itemprop="channelId" content="${CHANNEL_ID}"></script>`,
      'https://www.youtube.com/@example',
    )).toBeUndefined();
  });
});
