import { parseOkfDocument } from '@oldfolio/okf';

export interface TranscriptPlaybackSegment {
  readonly startMs: number;
  readonly label: string;
  readonly text: string;
  readonly speaker?: string;
}

export interface TranscriptPlaybackManifest {
  readonly title: string;
  readonly resource: string;
  readonly segments: readonly TranscriptPlaybackSegment[];
}

const TIMESTAMP_LINK = /^- \[(.+?)\]\(([^)]+)#t=(\d+(?:\.\d{1,3})?)\)(?: \*\*([^*]+):\*\*)?\s+(.+)$/u;

function bundleRelativePath(path: string): string {
  for (const prefix of ['bundles/personal/', 'bundles/synthesis/']) {
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  const creator = /^bundles\/creators\/[^/]+\/(.+)$/u.exec(path)?.[1];
  return creator ?? path;
}

function plainMarkdownText(value: string): string {
  return value.replaceAll('\\[', '[').replaceAll('\\]', ']').replaceAll('\\\\', '\\');
}

/** Reads the constrained timestamp list emitted by compileTranscriptDocument. */
export function parseTranscriptPlaybackManifest(content: string, path: string): TranscriptPlaybackManifest | null {
  const parsed = parseOkfDocument(content, bundleRelativePath(path));
  if (!parsed.valid || parsed.kind !== 'concept' || parsed.frontmatter?.type !== 'Transcript') return null;
  const resource = parsed.frontmatter.resource;
  if (typeof resource !== 'string' || !resource) return null;
  const segments: TranscriptPlaybackSegment[] = [];
  for (const line of parsed.body.split(/\r?\n/u)) {
    const match = TIMESTAMP_LINK.exec(line);
    if (!match || match[2] !== resource) continue;
    const seconds = Number(match[3]);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    segments.push({
      startMs: Math.round(seconds * 1_000),
      label: match[1] ?? '',
      text: plainMarkdownText(match[5] ?? ''),
      ...(match[4] ? { speaker: plainMarkdownText(match[4]) } : {}),
    });
  }
  if (segments.length === 0) return null;
  return {
    title: parsed.frontmatter.title ?? 'Transcript',
    resource,
    segments,
  };
}

/** Returns the transcript linked by an Oldfolio Synthesis so its timestamp anchors remain playable. */
export function parseSynthesisTranscriptPath(content: string, path: string): string | null {
  const parsed = parseOkfDocument(content, bundleRelativePath(path));
  if (!parsed.valid || parsed.kind !== 'concept' || parsed.frontmatter?.type !== 'Synthesis') return null;
  const sourcePath = parsed.frontmatter.oldfolio?.source_path;
  return typeof sourcePath === 'string' && sourcePath.endsWith('.md') ? sourcePath : null;
}
