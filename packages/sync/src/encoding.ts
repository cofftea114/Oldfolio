import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
export const decodeUtf8 = (value: Uint8Array): string => new TextDecoder().decode(value);

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error('Invalid base64url value.');
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding);
  } catch {
    throw new Error('Invalid base64url value.');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export { bytesToHex, hexToBytes };

export const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
