import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RssSourceConnector } from '@oldfolio/ingest';
import { parseOkfDocument } from '@oldfolio/okf';
import { VaultRepository } from '@oldfolio/vault';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CreatorTrackerService } from './creator-tracker.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function feed(entries: readonly { readonly id: string; readonly title: string }[]): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Creator Notes</title>${entries.map((entry) => [
    '<item>', `<guid>${entry.id}</guid>`, `<title>${entry.title}</title>`,
    `<link>https://example.com/posts/${entry.id}</link>`, '<description>Knowledge update</description>', '</item>',
  ].join('')).join('')}</channel></rss>`;
}

describe('creator tracker', () => {
  it('creates an isolated Creator bundle and stores refresh configuration in the Vault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-creator-tracker-'));
    roots.push(root);
    const vault = await VaultRepository.open(root);
    await vault.initialize();
    const connector = new RssSourceConnector({
      fetcher: () => Promise.resolve(new Response(feed([{ id: 'one', title: 'First' }]), {
        status: 200, headers: { 'content-type': 'application/rss+xml' },
      })),
      now: () => new Date('2026-08-24T00:00:00.000Z'),
    });
    const tracker = new CreatorTrackerService(vault, connector, () => new Date('2026-08-24T00:00:00.000Z'));

    const followed = await tracker.follow('https://example.com/feed.xml');
    expect(followed).toMatchObject({ title: 'Creator Notes', lastNewEntryCount: 0, entryCount: 1 });
    expect(followed.creatorDocumentPath).toBe(`bundles/creators/${followed.id}/wiki/creator.md`);
    const creator = await vault.read(followed.creatorDocumentPath);
    const parsed = parseOkfDocument(creator.text, 'wiki/creator.md');
    expect(parsed.valid).toBe(true);
    expect(parsed.frontmatter).toMatchObject({ type: 'Creator', oldfolio: { id: followed.id } });
    const documents = await vault.scanDocuments();
    expect(documents.some((document) => document.path.startsWith(`bundles/creators/${followed.id}/raw/feed-`))).toBe(true);
    expect((await vault.read('.oldfolio/config/creator-subscriptions.json')).text).not.toContain('Knowledge update');
    await expect(tracker.history(followed.id)).resolves.toMatchObject([{
      id: 'one', title: 'First', link: 'https://example.com/posts/one',
    }]);
    vault.close();
  });

  it('deduplicates unchanged checks and records only newly observed feed entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-creator-refresh-'));
    roots.push(root);
    const vault = await VaultRepository.open(root);
    await vault.initialize();
    let currentFeed = feed([{ id: 'one', title: 'First' }]);
    let clock = new Date('2026-08-24T00:00:00.000Z');
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(currentFeed, {
      status: 200, headers: { 'content-type': 'application/rss+xml' },
    })));
    const connector = new RssSourceConnector({ fetcher, now: () => clock });
    const tracker = new CreatorTrackerService(vault, connector, () => clock);
    const followed = await tracker.follow('https://example.com/feed.xml');

    clock = new Date('2026-08-24T01:00:00.000Z');
    const unchanged = await tracker.refresh(followed.id);
    expect(unchanged.lastNewEntryCount).toBe(0);
    currentFeed = feed([{ id: 'two', title: 'Second' }, { id: 'one', title: 'First' }]);
    clock = new Date('2026-08-24T02:00:00.000Z');
    const changed = await tracker.refresh(followed.id);
    expect(changed.lastNewEntryCount).toBe(1);
    expect((await vault.read(`bundles/creators/${followed.id}/log.md`)).text).toContain('发现 1 条新内容');
    const rawDocuments = (await vault.scanDocuments())
      .filter((document) => document.path.startsWith(`bundles/creators/${followed.id}/raw/`));
    expect(rawDocuments).toHaveLength(2);
    await expect(tracker.history(followed.id)).resolves.toMatchObject([
      { id: 'two', title: 'Second' }, { id: 'one', title: 'First' },
    ]);

    const remaining = await tracker.remove(followed.id);
    expect(remaining).toHaveLength(0);
    await expect(vault.read(followed.creatorDocumentPath)).resolves.toMatchObject({ path: followed.creatorDocumentPath });
    vault.close();
  });

  it('records refresh failures without deleting the last good snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-creator-failure-'));
    roots.push(root);
    const vault = await VaultRepository.open(root);
    await vault.initialize();
    let fail = false;
    const connector = new RssSourceConnector({
      fetcher: () => fail
        ? Promise.resolve(new Response('unavailable', { status: 503 }))
        : Promise.resolve(new Response(feed([{ id: 'one', title: 'First' }]), { status: 200 })),
    });
    const tracker = new CreatorTrackerService(vault, connector);
    const followed = await tracker.follow('https://example.com/feed.xml');
    fail = true;
    const refreshed = await tracker.refresh(followed.id);
    expect(refreshed.lastError).toContain('HTTP 503');
    expect(refreshed.lastSnapshotId).toBe(followed.lastSnapshotId);
    const listed = await tracker.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(followed.id);
    expect(listed[0]?.lastError).toContain('HTTP 503');
    vault.close();
  });

  it('backfills history for subscriptions created before entry catalogs were added', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-creator-history-migration-'));
    roots.push(root);
    const vault = await VaultRepository.open(root);
    await vault.initialize();
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(feed([
      { id: 'older', title: 'Older video' },
    ]), { status: 200 })));
    const connector = new RssSourceConnector({ fetcher });
    const tracker = new CreatorTrackerService(vault, connector);
    const followed = await tracker.follow('https://example.com/feed.xml');
    const config = await vault.read('.oldfolio/config/creator-subscriptions.json');
    const legacy = JSON.parse(config.text) as { subscriptions: Array<Record<string, unknown>> };
    delete legacy.subscriptions[0]?.['entries'];
    await vault.write('.oldfolio/config/creator-subscriptions.json', `${JSON.stringify(legacy)}\n`, config.revision);

    const restarted = new CreatorTrackerService(vault, connector);
    await expect(restarted.list()).resolves.toMatchObject([{ id: followed.id, entryCount: 0 }]);
    await expect(restarted.history(followed.id)).resolves.toMatchObject([{ id: 'older', title: 'Older video' }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(restarted.list()).resolves.toMatchObject([{ id: followed.id, entryCount: 1 }]);
    vault.close();
  });

  it('merges official YouTube history and preserves it during later Feed refreshes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-creator-youtube-history-'));
    roots.push(root);
    const vault = await VaultRepository.open(root);
    await vault.initialize();
    let currentFeed = feed([{ id: 'yt:video:newest', title: 'Newest video' }]);
    const connector = new RssSourceConnector({
      fetcher: () => Promise.resolve(new Response(currentFeed, { status: 200 })),
    });
    const tracker = new CreatorTrackerService(vault, connector);
    const followed = await tracker.follow('https://www.youtube.com/feeds/videos.xml?channel_id=UCvijahEyGtvMpmMHBu4FS2w');
    const imported = await tracker.importOfficialHistory(followed.id, {
      id: 'youtube-channel-UCvijahEyGtvMpmMHBu4FS2w-0123456789abcdef',
      connectorId: 'org.oldfolio.youtube-data-api',
      canonicalUri: 'https://www.youtube.com/channel/UCvijahEyGtvMpmMHBu4FS2w',
      fetchedAt: '2026-08-25T00:00:00.000Z',
      contentHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      title: 'Creator Notes — YouTube uploads',
      mimeType: 'application/json',
      text: '# History',
      metadata: {
        sourceLineageId: 'youtube-channel-UCvijahEyGtvMpmMHBu4FS2w',
        complete: true,
        totalResults: 2,
        entries: [
          { id: 'yt:video:newest', title: 'Newest video', link: 'https://www.youtube.com/watch?v=newest' },
          { id: 'yt:video:older', title: 'Older video', link: 'https://www.youtube.com/watch?v=older' },
        ],
      },
      deletionPolicy: { supportsRemoteDeletionSignals: false },
    });
    expect(imported).toMatchObject({
      entryCount: 2,
      historySource: 'youtube_data_api',
      historyComplete: true,
      historyTotalResults: 2,
      lastNewEntryCount: 1,
    });
    currentFeed = feed([{ id: 'yt:video:latest', title: 'Latest video' }]);
    await tracker.refresh(followed.id);
    await expect(tracker.list()).resolves.toMatchObject([{
      historySource: 'youtube_data_api', historyComplete: true, historyTotalResults: 2,
    }]);
    await expect(tracker.history(followed.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'yt:video:latest' }),
      expect.objectContaining({ id: 'yt:video:newest' }),
      expect.objectContaining({ id: 'yt:video:older' }),
    ]));
    const documents = await vault.scanDocuments();
    expect(documents.some((document) => document.path.includes('/raw/youtube-channel-UCvijahEyGtvMpmMHBu4FS2w/'))).toBe(true);
    vault.close();
  });
});
