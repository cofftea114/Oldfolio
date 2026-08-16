import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessRunner } from '@oldfolio/media';

import { detectPlatformMediaUrl, downloadPlatformMedia } from './platform-media.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('platform share media boundary', () => {
  it('recognizes supported YouTube, bilibili, and Douyin share hosts', () => {
    expect(detectPlatformMediaUrl('https://youtu.be/abc123')?.platform).toBe('youtube');
    expect(detectPlatformMediaUrl('https://www.bilibili.com/video/BV123')?.platform).toBe('bilibili');
    expect(detectPlatformMediaUrl('2.34 复制打开抖音 https://v.douyin.com/abc123/ 查看视频')?.platform).toBe('douyin');
    expect(detectPlatformMediaUrl('https://media.example.test/video.mp4')).toBeNull();
  });

  it('runs a user-selected yt-dlp without cookies, playlists, configs, or a shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-platform-media-'));
    roots.push(root);
    const run = vi.fn<ProcessRunner>(async (request) => {
      const mediaPath = join(request.cwd ?? root, 'abc123.m4a');
      await writeFile(mediaPath, 'audio bytes');
      return { exitCode: 0, stdout: `${mediaPath}\n`, stderr: '' };
    });

    const result = await downloadPlatformMedia('https://www.youtube.com/watch?v=abc123', {
      ytDlpPath: 'C:/tools/yt-dlp.exe',
      ffmpegPath: 'C:/tools/ffmpeg.exe',
      cacheRoot: root,
      authorizationConfirmed: true,
    }, { run });

    expect(result.platform).toBe('youtube');
    expect(result.mediaPath).toMatch(/abc123\.m4a$/u);
    const request = run.mock.calls[0]?.[0];
    expect(request?.executablePath).toBe('C:/tools/yt-dlp.exe');
    expect(request?.args).toContain('--no-config');
    expect(request?.args).toContain('--no-cookies');
    expect(request?.args).toContain('--no-cookies-from-browser');
    expect(request?.args).toContain('--no-cache-dir');
    expect(request?.args).toContain('--no-playlist');
    expect(request?.args.at(-1)).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('requires an explicit authorization confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-platform-confirm-'));
    roots.push(root);
    await expect(downloadPlatformMedia('https://b23.tv/abc123', {
      ytDlpPath: 'C:/tools/yt-dlp.exe', ffmpegPath: 'C:/tools/ffmpeg.exe', cacheRoot: root,
      authorizationConfirmed: false,
    })).rejects.toThrow(/有权/u);
  });
});
