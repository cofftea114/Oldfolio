import path from 'node:path';

import type { MarkdownHeading, MarkdownLink, MarkdownMetadata } from './types.js';
import { normalizeVaultPath } from './path-safety.js';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const HEADING = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/gm;
const WIKILINK = /(!)?\[\[([^\]\n]+)\]\]/g;
const MARKDOWN_LINK = /(!)?\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const INLINE_TAG = /(^|[\s(>])#([\p{L}\p{N}_/-]+)/gu;

function splitTarget(value: string): { target: string; anchor?: string } {
  const hash = value.indexOf('#');
  if (hash < 0) return { target: value.trim() };
  const target = value.slice(0, hash).trim();
  const anchor = value.slice(hash + 1).trim();
  return anchor.length > 0 ? { target, anchor } : { target };
}

function parseFrontmatter(text: string): { title?: string; tags: string[]; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { tags: [], body: text };
  const yaml = match[1] ?? '';
  const titleMatch = /^title:\s*(.+?)\s*$/m.exec(yaml);
  const title = titleMatch?.[1]?.replace(/^['"]|['"]$/g, '').trim();
  const tags = new Set<string>();
  const inlineTags = /^tags:\s*\[([^\]]*)\]\s*$/m.exec(yaml)?.[1];
  if (inlineTags) {
    for (const tag of inlineTags.split(',')) {
      const normalized = tag.trim().replace(/^['"#]|['"]$/g, '');
      if (normalized) tags.add(normalized);
    }
  }
  const blockTags = /^tags:\s*\r?\n((?:\s+-\s*[^\r\n]+\r?\n?)*)/m.exec(yaml)?.[1];
  if (blockTags) {
    for (const line of blockTags.split(/\r?\n/)) {
      const normalized = line
        .replace(/^\s+-\s*#?/, '')
        .trim()
        .replace(/^['"]|['"]$/g, '');
      if (normalized) tags.add(normalized);
    }
  }
  return {
    ...(title ? { title } : {}),
    tags: [...tags],
    body: text.slice(match[0].length),
  };
}

export function extractMarkdownMetadata(text: string): MarkdownMetadata {
  const frontmatter = parseFrontmatter(text);
  const headings: MarkdownHeading[] = [];
  for (const match of frontmatter.body.matchAll(HEADING)) {
    const marker = match[1];
    const value = match[2];
    if (!marker || !value) continue;
    headings.push({
      level: marker.length,
      text: value.trim(),
      line: frontmatter.body.slice(0, match.index).split(/\r?\n/).length,
    });
  }

  const links: MarkdownLink[] = [];
  for (const match of frontmatter.body.matchAll(WIKILINK)) {
    const inner = match[2];
    if (!inner) continue;
    const separator = inner.indexOf('|');
    const destination = separator < 0 ? inner : inner.slice(0, separator);
    const label = separator < 0 ? undefined : inner.slice(separator + 1).trim();
    const split = splitTarget(destination);
    if (!split.target && !split.anchor) continue;
    links.push({
      kind: 'wikilink',
      raw: match[0],
      target: split.target,
      ...(split.anchor ? { anchor: split.anchor } : {}),
      ...(label ? { label } : {}),
      embedded: match[1] === '!',
    });
  }

  for (const match of frontmatter.body.matchAll(MARKDOWN_LINK)) {
    const rawTarget = match[3]?.trim();
    if (!rawTarget || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(rawTarget)) continue;
    const unwrapped =
      rawTarget.startsWith('<') && rawTarget.endsWith('>')
        ? rawTarget.slice(1, -1)
        : (rawTarget.split(/\s+["']/)[0] ?? rawTarget);
    const split = splitTarget(unwrapped);
    links.push({
      kind: 'markdown',
      raw: match[0],
      target: split.target,
      ...(split.anchor ? { anchor: split.anchor } : {}),
      ...(match[2] ? { label: match[2] } : {}),
      embedded: match[1] === '!',
    });
  }

  const tags = new Set(frontmatter.tags);
  const withoutLinks = frontmatter.body.replace(WIKILINK, ' ').replace(MARKDOWN_LINK, ' ');
  for (const match of withoutLinks.matchAll(INLINE_TAG)) {
    if (match[2]) tags.add(match[2]);
  }

  const headingTitle = headings.find((heading) => heading.level === 1)?.text;
  const title = frontmatter.title ?? headingTitle;
  return {
    ...(title ? { title } : {}),
    headings,
    links,
    tags: [...tags].sort((left, right) => left.localeCompare(right)),
  };
}

export function resolveMarkdownTarget(
  sourcePath: string,
  rawTarget: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  if (!rawTarget) return sourcePath;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawTarget).replaceAll('\\', '/');
  } catch {
    decoded = rawTarget.replaceAll('\\', '/');
  }
  if (decoded.startsWith('/')) decoded = decoded.slice(1);
  const extension = path.posix.extname(decoded);
  const withExtension = extension ? decoded : `${decoded}.md`;
  const relativeCandidate = path.posix.join(path.posix.dirname(sourcePath), withExtension);
  const candidates: string[] = [];
  for (const candidate of [relativeCandidate, withExtension]) {
    try {
      candidates.push(normalizeVaultPath(candidate));
    } catch {
      // An unsafe link is retained as unresolved metadata, never used as a path.
    }
  }
  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) return candidate;
  }

  if (!decoded.includes('/')) {
    const basename = path.posix.basename(withExtension).toLocaleLowerCase();
    const matches = [...knownPaths].filter(
      (candidate) => path.posix.basename(candidate).toLocaleLowerCase() === basename,
    );
    if (matches.length === 1) return matches[0] ?? null;
  }
  return candidates[0] ?? null;
}
