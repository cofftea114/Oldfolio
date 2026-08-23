import type { DocumentCategory } from '../shared/contracts.js';

const RESERVED_BUNDLE_DOCUMENT = /^bundles\/(?:personal|synthesis|creators\/[^/]+)\/(?:index|log)\.md$/u;
const RAW_BUNDLE_DOCUMENT = /^bundles\/(?:personal|synthesis|creators\/[^/]+)\/raw\//u;
const TRANSCRIPT_DOCUMENT = /^bundles\/(?:personal|synthesis|creators\/[^/]+)\/wiki\/transcripts\//u;
const SUMMARY_DOCUMENT = /^bundles\/(?:personal|synthesis|creators\/[^/]+)\/wiki\/summaries\//u;
const CONCEPT_DOCUMENT = /^bundles\/(?:personal|synthesis|creators\/[^/]+)\/wiki\/concepts\//u;
const WIKI_DOCUMENT = /^bundles\/(?:personal|synthesis|creators\/[^/]+)\/wiki\//u;

/** Maps physical Vault documents to the user-facing sidebar information architecture. */
export function classifyDocumentPath(path: string): DocumentCategory {
  if (RESERVED_BUNDLE_DOCUMENT.test(path) || RAW_BUNDLE_DOCUMENT.test(path)) return 'internal';
  if (TRANSCRIPT_DOCUMENT.test(path)) return 'transcript';
  if (SUMMARY_DOCUMENT.test(path)) return 'summary';
  if (CONCEPT_DOCUMENT.test(path)) return 'concept';
  if (WIKI_DOCUMENT.test(path)) return 'knowledge';
  return 'note';
}

export function isDocumentManageable(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return normalized.toLocaleLowerCase().endsWith('.md')
    && !normalized.startsWith('.oldfolio/')
    && classifyDocumentPath(normalized) !== 'internal';
}
