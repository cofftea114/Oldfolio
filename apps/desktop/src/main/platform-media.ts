import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import { validateSourceUrl } from '@oldfolio/ingest';
import { ControlledProcessError, runControlledProcess, type ProcessRunner } from '@oldfolio/media';

const MAX_PLATFORM_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;
const MEDIA_EXTENSIONS = new Set([
  '.aac', '.flac', '.m4a', '.mkv', '.mov', '.mp3', '.mp4', '.mpeg', '.mpg', '.ogg', '.opus', '.wav', '.webm',
]);

function boundedProcessDiagnostic(error: ControlledProcessError): string {
  const raw = `${error.result?.stderr ?? ''}\n${error.result?.stdout ?? ''}`;
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');
  const lines = raw
    .replaceAll(ansiPattern, '')
    .split(/\r?\n/u)
    .map((line) => line.replaceAll(/[\t ]+/gu, ' ').trim())
    .filter(Boolean);
  const selected = [...lines].reverse().find((line) => /^error:/iu.test(line)) ?? lines.at(-1) ?? '';
  return selected
    .replace(/^error:\s*/iu, '')
    .replaceAll(/[A-Za-z]:\\[^\s"'<>]+/gu, '[本地路径]')
    .replaceAll(/https?:\/\/[^\s"'<>]+/gu, (value) => {
      try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
      } catch {
        return '[远程地址]';
      }
    })
    .slice(0, 500);
}

function actionablePlatformProcessError(error: unknown): Error {
  if (!(error instanceof ControlledProcessError)) return error instanceof Error ? error : new Error('平台媒体解析失败。');
  if (error.code === 'spawn_failed') {
    return new Error('无法启动 yt-dlp。请在媒体设置中重新选择有效的 yt-dlp 可执行文件。', { cause: error });
  }
  if (error.code === 'timeout') return new Error('平台媒体解析超时，请检查网络后重试。', { cause: error });
  if (error.code === 'output_limit') return new Error('yt-dlp 返回了过多输出，任务已安全停止。请更新 yt-dlp 后重试。', { cause: error });
  if (error.code !== 'nonzero_exit') return error;

  const detail = boundedProcessDiagnostic(error);
  if (/sign in|log ?in|cookies?|not a bot|captcha|人机|登录/iu.test(detail)) {
    return new Error(
      '平台要求登录或人机验证。Oldfolio 不读取浏览器 Cookie；请改为导入你有权使用的本地文件，或使用平台正式授权能力。',
      { cause: error },
    );
  }
  if (/unsupported url/iu.test(detail)) {
    return new Error('当前 yt-dlp 不支持这个链接。请确认它是单个视频分享链接，并尝试更新 yt-dlp。', { cause: error });
  }
  if (/update|outdated|newer version/iu.test(detail)) {
    return new Error('当前 yt-dlp 版本可能过旧。请更新 yt-dlp 后重新选择该可执行文件。', { cause: error });
  }
  if (/ffmpeg|ffprobe/iu.test(detail) && /not found|not installed|unable to|cannot|could not/iu.test(detail)) {
    return new Error('yt-dlp 无法使用 FFmpeg。请确认 FFmpeg 与 ffprobe 位于同一目录，并重新保存媒体工具配置。', { cause: error });
  }
  if (/403|forbidden|access denied|geo.?restrict/iu.test(detail)) {
    return new Error(
      '平台拒绝了无 Cookie 的媒体访问。即使浏览器可以播放，其登录会话或播放器令牌也不会提供给 Oldfolio；请改为导入你有权使用的本地文件。',
      { cause: error },
    );
  }
  if (/private video|video unavailable|not available|has been removed/iu.test(detail)) {
    return new Error('该视频不可公开访问、已删除或需要额外权限，无法通过当前连接器分析。', { cause: error });
  }
  return new Error(
    `yt-dlp 解析失败（退出码 ${String(error.result?.exitCode ?? 1)}）${detail ? `：${detail}` : '。请更新 yt-dlp 并检查链接后重试。'}`,
    { cause: error },
  );
}

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
    // Platform titles can contain characters emitted with the Windows console code page.
    // Keep the temporary filename ASCII-only and discover it through the filesystem instead
    // of trusting a path decoded from yt-dlp stdout.
    const outputTemplate = join(temporaryDirectory, '%(id)s.%(ext)s');
    const runner = options.run ?? runControlledProcess;
    try {
      await runner({
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
          '--', detected.url.href,
        ],
        cwd: temporaryDirectory,
        timeoutMs: 2 * 60 * 60 * 1_000,
        maxOutputBytes: 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw actionablePlatformProcessError(error);
    }
    const entries = await readdir(temporaryDirectory, { withFileTypes: true });
    const mediaFiles = entries.filter((entry) => entry.isFile() && MEDIA_EXTENSIONS.has(extname(entry.name).toLowerCase()));
    if (mediaFiles.length !== 1) throw new Error('平台解析器没有生成唯一的媒体文件。');
    const candidate = resolve(temporaryDirectory, mediaFiles[0]!.name);
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
