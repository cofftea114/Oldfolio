import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { handleVaultMediaRequest, mediaPlaybackUrl, parseSingleByteRange } from './media-protocol.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('Vault media protocol', () => {
  it('parses bounded and suffix ranges', () => {
    expect(parseSingleByteRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseSingleByteRange('bytes=7-', 10)).toEqual({ start: 7, end: 9 });
    expect(parseSingleByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(() => parseSingleByteRange('bytes=10-11', 10)).toThrow(RangeError);
    expect(() => parseSingleByteRange('bytes=0-1,4-5', 10)).toThrow(RangeError);
  });

  it('streams only content-addressed Vault media and honors Range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-media-protocol-'));
    roots.push(root);
    const bytes = Buffer.from('0123456789');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const resource = `assets/media/${hash}.mp3`;
    await mkdir(join(root, 'assets/media'), { recursive: true });
    await writeFile(join(root, ...resource.split('/')), bytes);
    const url = mediaPlaybackUrl(resource);
    const response = await handleVaultMediaRequest(new Request(url, { headers: { range: 'bytes=2-5' } }), root);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('2345');
    expect(await handleVaultMediaRequest(new Request('oldfolio-media://vault/notes/private.md'), root)).toMatchObject({ status: 403 });
    expect(await handleVaultMediaRequest(new Request(url, { headers: { range: 'bytes=100-200' } }), root)).toMatchObject({ status: 416 });
    expect(() => mediaPlaybackUrl('C:/private/video.mp4')).toThrow(/content-addressed/);
  });
});
