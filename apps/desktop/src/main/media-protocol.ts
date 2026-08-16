import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { VaultPathResolver } from '@oldfolio/vault';

const MEDIA_ASSET = /^assets\/media\/[a-f0-9]{64}\.(aac|flac|m4a|mkv|mov|mp3|mp4|mpeg|mpg|ogg|opus|wav|webm)$/iu;
const MIME_TYPES: Readonly<Record<string, string>> = {
  aac: 'audio/aac', flac: 'audio/flac', m4a: 'audio/mp4', mkv: 'video/x-matroska', mov: 'video/quicktime',
  mp3: 'audio/mpeg', mp4: 'video/mp4', mpeg: 'video/mpeg', mpg: 'video/mpeg', ogg: 'audio/ogg',
  opus: 'audio/ogg', wav: 'audio/wav', webm: 'video/webm',
};

export interface MediaByteRange {
  readonly start: number;
  readonly end: number;
}

export function parseSingleByteRange(value: string | null, size: number): MediaByteRange | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) throw new RangeError('Unsupported media range.');
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RangeError('Invalid media range.');
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    throw new RangeError('Invalid media range.');
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export function mediaPlaybackUrl(resource: string): string {
  if (!MEDIA_ASSET.test(resource)) throw new Error('Only content-addressed Vault media can be played.');
  return `oldfolio-media://vault/${resource.split('/').map(encodeURIComponent).join('/')}`;
}

function errorResponse(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export async function handleVaultMediaRequest(request: Request, vaultRoot: string | null): Promise<Response> {
  if (!vaultRoot) return errorResponse(404, 'No Vault is open.');
  const url = new URL(request.url);
  if (url.hostname !== 'vault' || request.method !== 'GET') return errorResponse(405, 'Unsupported media request.');
  let resource: string;
  try {
    resource = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
  } catch {
    return errorResponse(400, 'Invalid media path encoding.');
  }
  if (!MEDIA_ASSET.test(resource)) return errorResponse(403, 'Media path is not authorized.');
  try {
    const resolver = await VaultPathResolver.create(vaultRoot);
    await resolver.assertNoSymlinks(resource);
    const { absolutePath } = resolver.resolve(resource);
    const status = await lstat(absolutePath);
    if (!status.isFile() || status.isSymbolicLink() || status.size <= 0) return errorResponse(404, 'Media asset not found.');
    const range = parseSingleByteRange(request.headers.get('range'), status.size);
    const extension = resource.slice(resource.lastIndexOf('.') + 1).toLowerCase();
    const headers = new Headers({
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
      'content-length': String(range ? range.end - range.start + 1 : status.size),
      ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${status.size}` } : {}),
    });
    const stream = createReadStream(absolutePath, range ?? undefined);
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers });
  } catch (error: unknown) {
    if (error instanceof RangeError) return new Response(null, { status: 416 });
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return errorResponse(404, 'Media asset not found.');
    return errorResponse(403, 'Media request rejected.');
  }
}
