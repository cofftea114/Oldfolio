import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseOkfDocument } from '@oldfolio/okf';
import { VaultRepository } from '@oldfolio/vault';

import { LocalFileSourceConnector } from './local-file.js';
import { IngestionPipeline } from './pipeline.js';
import { parseFeed, RssSourceConnector } from './rss.js';
import { fetchBoundedText, validateSourceUrl } from './url-policy.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Oldfolio Podcast</title>
    <item>
      <guid>episode-1</guid>
      <title>Local-first &amp; durable</title>
      <link>https://example.com/episodes/1</link>
      <pubDate>Tue, 11 Aug 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>Keep the source and cite it.</p>]]></description>
      <enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg" length="1234"/>
      <itunes:duration>00:10:00</itunes:duration>
    </item>
  </channel>
</rss>`;

describe('lawful source ingestion', () => {
  it('parses podcast RSS without executing embedded markup', () => {
    const feed = parseFeed(RSS);
    expect(feed.format).toBe('rss');
    expect(feed.podcast).toBe(true);
    expect(feed.entries[0]).toMatchObject({
      id: 'episode-1',
      title: 'Local-first & durable',
      summary: 'Keep the source and cite it.',
      duration: '00:10:00',
    });
  });

  it('imports a feed snapshot into a strict OKF Source document in a vault', async () => {
    const connector = new RssSourceConnector({
      fetcher: () =>
        Promise.resolve(new Response(RSS, {
          status: 200,
          headers: { 'content-type': 'application/rss+xml', etag: '"feed-v1"' },
        })),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });
    const pipeline = new IngestionPipeline([connector]);
    const result = await pipeline.ingest(connector.id, {
      input: { kind: 'feed', url: 'https://example.com/feed.xml' },
      capabilities: ['metadata', 'content', 'subscription'],
    });
    const parsed = parseOkfDocument(result.document.content, result.document.path.replace('bundles/personal/', ''));
    expect(parsed.valid).toBe(true);
    expect(parsed.frontmatter).toMatchObject({ type: 'Source', oldfolio: { id: result.snapshot.id } });
    expect(result.document.content).toContain('untrusted source data');

    const root = await mkdtemp(join(tmpdir(), 'oldfolio-ingest-'));
    roots.push(root);
    const vault = await VaultRepository.open(root);
    await vault.initialize();
    const saved = await vault.write(result.document.path, result.document.content, null);
    expect(saved.revision).toHaveLength(64);
    expect((await vault.read(result.document.path)).text).toBe(result.document.content);
    vault.close();
  });

  it('imports user files through an injected reader and detects captions', async () => {
    const connector = new LocalFileSourceConnector({
      read: () => Promise.resolve({
        bytes: new TextEncoder().encode('WEBVTT\n\n00:00.000 --> 00:01.000\nHello'),
        displayName: 'caption.vtt',
        mimeType: 'text/vtt',
      }),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
    });
    const probe = await connector.probe({ kind: 'file', uri: 'C:/media/caption.vtt' });
    expect(probe.capabilities).toContainEqual({
      capability: 'captions',
      availability: 'available',
      authorization: 'user_import',
    });
    const snapshot = await connector.fetch({
      input: { kind: 'file', uri: 'C:/media/caption.vtt' },
      capabilities: ['metadata', 'captions'],
    });
    expect(snapshot.text).toContain('Hello');
  });
});

describe('remote source boundary', () => {
  it('blocks credentials and private network literals by default', () => {
    expect(() => validateSourceUrl('https://user:pass@example.com/feed')).toThrow(/Credentials/);
    expect(() => validateSourceUrl('https://127.0.0.1/feed')).toThrow(/Private-network/);
    expect(() => validateSourceUrl('http://example.com/feed')).toThrow(/HTTPS/);
  });

  it('validates redirect targets and response size', async () => {
    const redirecting: typeof fetch = () =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }));
    await expect(fetchBoundedText('https://example.com/feed', redirecting)).rejects.toThrow(/Private-network/);

    const oversized: typeof fetch = () =>
      Promise.resolve(new Response('12345', { status: 200, headers: { 'content-length': '5' } }));
    await expect(fetchBoundedText('https://example.com/feed', oversized, { maxBytes: 4 })).rejects.toThrow(
      /exceeds/,
    );

    await expect(fetchBoundedText('https://example.com/page', oversized, {
      maxBytes: 4,
      truncateAtMaxBytes: true,
    })).resolves.toMatchObject({ text: '1234', truncated: true });
  });
});
