import type { DocumentCategory } from '../shared/contracts.js';

const RESERVED_BUNDLE_DOCUMENT = /^bundles\/(?:personal|synthesis|creators\/[^/]+)\/(?:index|log)\.md$/u;
const RAW_BUNDLE_DOCUMENT = /^bundles\/(?:personal|synthesis|creators\/[^/]+)\/raw\//u;
const TRANSCRIPT_DOCUMENT = /^bundles\/(?:personal|synthesis|creators\/[^/]+)\/wiki\/transcripts\//u;

/** Maps physical Vault documents to the user-facing sidebar information architecture. */
export function classifyDocumentPath(path: string): DocumentCategory {
  if (RESERVED_BUNDLE_DOCUMENT.test(path) || RAW_BUNDLE_DOCUMENT.test(path)) return 'internal';
  if (TRANSCRIPT_DOCUMENT.test(path)) return 'transcript';
  return 'knowledge';
}

export function isDocumentManageable(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return normalized.toLocaleLowerCase().endsWith('.md')
    && !normalized.startsWith('.oldfolio/')
    && classifyDocumentPath(normalized) !== 'internal';
}
