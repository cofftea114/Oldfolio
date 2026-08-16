const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u;
const WIKILINK = /(!)?\[\[([^\]\n]+)\]\]/gu;

function readableWikiLabel(target: string): string {
  const withoutAnchor = target.split('#', 1)[0] ?? target;
  const basename = withoutAnchor.replaceAll('\\', '/').split('/').at(-1) ?? withoutAnchor;
  return basename.replace(/\.md$/iu, '') || '当前笔记';
}

/** Converts stored Obsidian Markdown into safe input for the read-only renderer. */
export function prepareMarkdownForReading(source: string): string {
  const body = source.replace(FRONTMATTER, '');
  return body.replace(WIKILINK, (_raw, embedded: string | undefined, value: string) => {
    const separator = value.indexOf('|');
    const target = (separator < 0 ? value : value.slice(0, separator)).trim();
    const label = (separator < 0 ? readableWikiLabel(target) : value.slice(separator + 1).trim()) || readableWikiLabel(target);
    const href = `#oldfolio-note=${encodeURIComponent(target)}`;
    return `${embedded ? '!' : ''}[${label}](${href})`;
  });
}

export function parseMediaTimestamp(href: string): number | null {
  if (!/^assets\/media\/[a-f0-9]{64}\.[a-z0-9]+#t=/iu.test(href)) return null;
  const seconds = Number(new URL(href, 'https://oldfolio.invalid/').hash.slice(3));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : null;
}

export function parseWikiTarget(href: string): string | null {
  if (!href.startsWith('#oldfolio-note=')) return null;
  try {
    return decodeURIComponent(href.slice('#oldfolio-note='.length));
  } catch {
    return null;
  }
}
