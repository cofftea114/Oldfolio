import { isIP } from 'node:net';

export interface SourceUrlPolicy {
  readonly allowHttp?: boolean;
  readonly allowPrivateHosts?: boolean;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
}

export interface BoundedTextResponse {
  readonly finalUrl: string;
  readonly text: string;
  readonly mimeType?: string;
  readonly etag?: string;
  readonly lastModified?: string;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a = -1, b = -1] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/u.test(normalized)
  );
}

export function validateSourceUrl(value: string, policy: SourceUrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Source URL must be an absolute URL.');
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp === true && url.protocol === 'http:')) {
    throw new Error('Remote sources require HTTPS.');
  }
  if (url.username || url.password) throw new Error('Credentials are not allowed in source URLs.');
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  const localName = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local');
  const privateLiteral =
    (isIP(hostname) === 4 && isPrivateIpv4(hostname)) ||
    (isIP(hostname) === 6 && isPrivateIpv6(hostname));
  if (policy.allowPrivateHosts !== true && (localName || privateLiteral)) {
    throw new Error('Private-network source URLs require an explicit opt-in.');
  }
  url.hash = '';
  return url;
}

function combineAbortSignals(signal: AbortSignal | undefined, timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Source request timed out.')), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted === true) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Source response exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel('response too large');
      throw new Error(`Source response exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(result.value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Fetches text without ambient credentials, validating every redirect and bounding memory use. */
export async function fetchBoundedText(
  value: string,
  fetcher: typeof fetch = fetch,
  policy: SourceUrlPolicy = {},
  signal?: AbortSignal,
): Promise<BoundedTextResponse> {
  const maxRedirects = policy.maxRedirects ?? 3;
  const timeout = combineAbortSignals(signal, policy.timeoutMs ?? 30_000);
  let current = validateSourceUrl(value, policy);
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      const response = await fetcher(current, {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'manual',
        signal: timeout.signal,
        headers: { Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml, text/plain;q=0.8' },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Source redirect did not include a location.');
        if (redirects === maxRedirects) throw new Error('Source exceeded its redirect limit.');
        current = validateSourceUrl(new URL(location, current).toString(), policy);
        continue;
      }
      if (!response.ok) throw new Error(`Source request failed with HTTP ${response.status}.`);
      const bytes = await readBounded(response, policy.maxBytes ?? DEFAULT_MAX_BYTES);
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');
      return {
        finalUrl: current.toString(),
        text: new TextDecoder().decode(bytes),
        ...(contentType ? { mimeType: contentType } : {}),
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      };
    }
    throw new Error('Source redirect loop detected.');
  } finally {
    timeout.dispose();
  }
}
