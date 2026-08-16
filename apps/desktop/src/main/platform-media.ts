import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import { validateSourceUrl } from '@oldfolio/ingest';
import { runControlledProcess, type ProcessRunner } from '@oldfolio/media';

const MAX_PLATFORM_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;
const MEDIA_EXTENSIONS = new Set([
  '.aac', '.flac', '.m4a', '.mkv', '.mov', '.mp3', '.mp4', '.mpeg', '.mpg', '.ogg', '.opus', '.wav', '.webm',
]);

export type PlatformMediaId = 'youtube' | 'bilibili' | 'douyin';

export interface PlatformMediaDownload {
  readonly platform: PlatformMediaId;
  readonly sourceUrl: string;
  readonly mediaPath: string;
  readonly temporaryDirectory: string;
}

export function extractSharedMediaUrl(value: string): string {
  const trimmed = value.trim();
  const match = /https:\/\/[^\s<>"']+/iu.exec(trimmed);
  if (!match) throw new Error('请粘贴 HTTPS 媒体地址或平台分享文本。');
  return match[0].replace(/[),.;!?，。；！？]+$/u, '');
}

function hostMatches(hostname: string, base: string): boolean {
  return hostname === base || hostname.endsWith(`.${base}`);
}

export function detectPlatformMediaUrl(value: string): { readonly platform: PlatformMediaId; readonly url: URL } | null {
  const url = validateSourceUrl(extractSharedMediaUrl(value));
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'youtu.be' || hostMatches(hostname, 'youtube.com') || hostMatches(hostname, 'youtube-nocookie.com')) {
    return { platform: 'youtube', url };
  }
  if (hostname === 'b23.tv' || hostMatches(hostname, 'bilibili.com')) return { platform: 'bilibili', url };
  if (hostMatches(hostname, 'douyin.com')) return { platform: 'douyin', url };
  return null;
}

/** Uses a user-selected yt-dlp binary without browser cookies, playlists, config files, or shell execution. */
export async function downloadPlatformMedia(
  value: string,
  input: {
    readonly ytDlpPath: string;
    readonly ffmpegPath: string;
    readonly cacheRoot: string;
    readonly authorizationConfirmed: boolean;
  },
  options: { readonly run?: ProcessRunner; readonly signal?: AbortSignal } = {},
): Promise<PlatformMediaDownload> {
  const detected = detectPlatformMediaUrl(value);
  if (!detected) throw new Error('该地址不是受支持的 YouTube、哔哩哔哩或抖音分享链接。');
  if (!input.authorizationConfirmed) throw new Error('请先确认你有权下载并分析该视频。');
  await mkdir(input.cacheRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(input.cacheRoot, 'platform-'));
  let completed = false;
  try {
    const outputTemplate = join(temporaryDirectory, '%(title).150B [%(id)s].%(ext)s');
    const runner = options.run ?? runControlledProcess;
    const result = await runner({
      executablePath: input.ytDlpPath,
      args: [
        '--no-config',
        '--no-playlist',
        '--no-cookies',
        '--no-cookies-from-browser',
        '--no-cache-dir',
        '--no-progress',
        '--no-warnings',
        '--max-filesize', '2G',
        '--format', 'bestaudio/best',
        '--ffmpeg-location', dirname(input.ffmpegPath),
        '--output', outputTemplate,
        '--print', 'after_move:filepath',
        '--', detected.url.href,
      ],
      cwd: temporaryDirectory,
      timeoutMs: 2 * 60 * 60 * 1_000,
      maxOutputBytes: 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const printed = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
    if (!printed) throw new Error('平台解析器没有返回媒体文件。');
    const candidate = resolve(temporaryDirectory, printed);
    const child = relative(temporaryDirectory, candidate);
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('平台解析器返回了不受控的文件路径。');
    const [rootPath, mediaPath] = await Promise.all([realpath(temporaryDirectory), realpath(candidate)]);
    const realChild = relative(rootPath, mediaPath);
    if (!realChild || realChild.startsWith('..') || isAbsolute(realChild)) throw new Error('平台媒体文件越出了受控缓存目录。');
    const status = await lstat(mediaPath);
    if (!status.isFile() || status.isSymbolicLink() || status.size <= 0 || status.size > MAX_PLATFORM_MEDIA_BYTES) {
      throw new Error('平台媒体必须是不超过 2 GB 的普通文件。');
    }
    if (!MEDIA_EXTENSIONS.has(extname(mediaPath).toLowerCase())) throw new Error('平台解析器返回了不受支持的媒体格式。');
    completed = true;
    return { platform: detected.platform, sourceUrl: detected.url.href, mediaPath, temporaryDirectory };
  } finally {
    if (!completed) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
