import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadRemoteMediaAsset } from './remote-media.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('remote media download', () => {
  it('streams a public HTTPS direct media URL into a content-addressed asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-remote-media-'));
    roots.push(root);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.byteLength) },
    }));

    const asset = await downloadRemoteMediaAsset('https://media.example.test/path/video', root, { fetcher });

    expect(asset.vaultPath).toMatch(/^assets\/media\/[a-f0-9]{64}\.mp4$/u);
    expect(asset.originalName).toBe('online-media.mp4');
    expect(new Uint8Array(await readFile(asset.absolutePath))).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      credentials: 'omit', redirect: 'manual',
    }));
  });

  it('rejects private hosts and responses that exceed the configured limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-remote-media-limit-'));
    roots.push(root);
    await expect(downloadRemoteMediaAsset('https://127.0.0.1/video.mp4', root)).rejects.toThrow(/Private-network/iu);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(12), {
      status: 200, headers: { 'content-type': 'video/mp4' },
    }));
    await expect(downloadRemoteMediaAsset('https://media.example.test/video.mp4', root, {
      fetcher, maxBytes: 8,
    })).rejects.toThrow(/限制/u);
  });
});

