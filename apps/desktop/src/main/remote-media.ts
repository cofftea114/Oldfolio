import { createHash, randomUUID } from 'node:crypto';
import { open as openFile, mkdir, rename, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { validateSourceUrl } from '@oldfolio/ingest';
import type { ImportedMediaAsset } from '@oldfolio/media';

const MAX_REMOTE_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MEDIA_EXTENSIONS = new Set([
  '.aac', '.flac', '.m4a', '.mkv', '.mov', '.mp3', '.mp4', '.mpeg', '.mpg', '.ogg', '.opus', '.wav', '.webm',
]);
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/webm': '.webm',
  'video/mp4': '.mp4',
  'video/mpeg': '.mpeg',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
};

export interface RemoteMediaDownloadOptions {
  readonly fetcher?: typeof fetch;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly signal?: AbortSignal;
}

function displayName(url: URL, extension: string): string {
  let name: string;
  try {
    name = decodeURIComponent(basename(url.pathname));
  } catch {
    name = basename(url.pathname);
  }
  return name && extname(name) ? name.slice(0, 240) : `online-media${extension}`;
}

function mediaExtension(url: URL, contentType: string | null): string {
  const fromPath = extname(url.pathname).toLowerCase();
  if (MEDIA_EXTENSIONS.has(fromPath)) return fromPath;
  const mimeType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  const fromMime = mimeType ? MIME_EXTENSIONS[mimeType] : undefined;
  if (fromMime) return fromMime;
  throw new Error('在线地址没有返回受支持的音视频类型。请使用直接指向媒体文件的 HTTPS 链接。');
}

/** Downloads a public HTTPS media file without credentials into a content-addressed Vault asset. */
export async function downloadRemoteMediaAsset(
  value: string,
  vaultRoot: string,
  options: RemoteMediaDownloadOptions = {},
): Promise<ImportedMediaAsset & { readonly finalUrl: string; readonly mimeType?: string }> {
  const fetcher = options.fetcher ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_REMOTE_MEDIA_BYTES;
  const maxRedirects = options.maxRedirects ?? 3;
  let current = validateSourceUrl(value);
  const directory = join(vaultRoot, 'assets', 'media');
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.download`);
  const handle = await openFile(temporary, 'wx', 0o600);
  let completed = false;
  try {
    let response: Response | undefined;
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      response = await fetcher(current, {
        method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'manual',
        ...(options.signal ? { signal: options.signal } : {}),
        headers: { Accept: 'video/*, audio/*, application/octet-stream;q=0.5' },
      });
      if (!REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get('location');
      if (!location) throw new Error('在线媒体重定向缺少目标地址。');
      if (redirects === maxRedirects) throw new Error('在线媒体重定向次数过多。');
      current = validateSourceUrl(new URL(location, current).toString());
      response = undefined;
    }
    if (!response) throw new Error('在线媒体重定向失败。');
    if (!response.ok) throw new Error(`在线媒体请求失败（HTTP ${response.status}）。`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`在线媒体超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MB 限制。`);
    }
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
    const extension = mediaExtension(current, mimeType ?? null);
    if (!response.body) throw new Error('在线媒体响应没有内容。');
    const reader = response.body.getReader();
    const hash = createHash('sha256');
    let byteLength = 0;
    while (true) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('在线媒体下载已取消。');
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel('response too large');
        throw new Error(`在线媒体超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MB 限制。`);
      }
      hash.update(chunk.value);
      await handle.write(chunk.value);
    }
    if (byteLength === 0) throw new Error('在线媒体文件为空。');
    await handle.sync();
    await handle.close();
    const contentHash = hash.digest('hex');
    const vaultPath = `assets/media/${contentHash}${extension}`;
    const absolutePath = join(vaultRoot, ...vaultPath.split('/'));
    try {
      await rename(temporary, absolutePath);
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      await rm(temporary, { force: true });
    }
    completed = true;
    return {
      originalName: displayName(current, extension),
      contentHash,
      byteLength,
      vaultPath,
      absolutePath,
      finalUrl: current.toString(),
      ...(mimeType ? { mimeType } : {}),
    };
  } finally {
    if (!completed) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
  }
}
