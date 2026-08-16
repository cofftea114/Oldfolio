import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AITranscriptionResult } from '@oldfolio/domain';

import { parseCaptions } from './captions.js';
import { deriveFfprobePath } from './media-analysis.js';
import type { ProcessRunner } from './whisper.js';

const TEXT_CODECS = new Set([
  'ass', 'eia_608', 'eia_708', 'jacosub', 'microdvd', 'mov_text', 'mpl2', 'pjs', 'realtext', 'sami',
  'ssa', 'srt', 'subrip', 'subviewer', 'subviewer1', 'text', 'vplayer', 'webvtt',
]);
const BITMAP_CODECS = new Set(['dvb_subtitle', 'dvd_subtitle', 'hdmv_pgs_subtitle', 'xsub']);

export interface EmbeddedSubtitleTrack {
  readonly index: number;
  readonly codec: string;
  readonly kind: 'text' | 'bitmap' | 'unknown';
  readonly language?: string;
  readonly title?: string;
  readonly default: boolean;
  readonly forced: boolean;
}

interface ProbeStream {
  readonly index?: unknown;
  readonly codec_name?: unknown;
  readonly codec_type?: unknown;
  readonly tags?: { readonly language?: unknown; readonly title?: unknown };
  readonly disposition?: { readonly default?: unknown; readonly forced?: unknown };
}

function languageAliases(language: string): ReadonlySet<string> {
  const normalized = language.trim().toLowerCase().split(/[-_]/u)[0] ?? '';
  if (['zh', 'zho', 'chi', 'cmn'].includes(normalized)) return new Set(['zh', 'zho', 'chi', 'cmn']);
  if (['en', 'eng'].includes(normalized)) return new Set(['en', 'eng']);
  if (['ja', 'jpn'].includes(normalized)) return new Set(['ja', 'jpn']);
  if (['ko', 'kor'].includes(normalized)) return new Set(['ko', 'kor']);
  return new Set([normalized]);
}

function trackKind(codec: string): EmbeddedSubtitleTrack['kind'] {
  if (TEXT_CODECS.has(codec)) return 'text';
  if (BITMAP_CODECS.has(codec)) return 'bitmap';
  return 'unknown';
}

export async function probeEmbeddedSubtitleTracks(
  mediaPath: string,
  ffmpegPath: string,
  run: ProcessRunner,
  signal?: AbortSignal,
): Promise<readonly EmbeddedSubtitleTrack[]> {
  const result = await run({
    executablePath: deriveFfprobePath(ffmpegPath),
    args: [
      '-v', 'error', '-select_streams', 's',
      '-show_entries', 'stream=index,codec_name,codec_type:stream_tags=language,title:stream_disposition=default,forced',
      '-of', 'json', mediaPath,
    ],
    cwd: dirname(mediaPath),
    timeoutMs: 60_000,
    maxOutputBytes: 2 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  let streams: readonly ProbeStream[];
  try {
    const value = JSON.parse(result.stdout) as { readonly streams?: unknown };
    streams = Array.isArray(value.streams) ? value.streams as readonly ProbeStream[] : [];
  } catch {
    throw new Error('ffprobe returned invalid subtitle stream JSON.');
  }
  return streams.flatMap((stream) => {
    if (stream.codec_type !== 'subtitle' || !Number.isSafeInteger(stream.index) || typeof stream.codec_name !== 'string') return [];
    const codec = stream.codec_name.toLowerCase();
    return [{
      index: stream.index as number,
      codec,
      kind: trackKind(codec),
      ...(typeof stream.tags?.language === 'string' && stream.tags.language ? { language: stream.tags.language } : {}),
      ...(typeof stream.tags?.title === 'string' && stream.tags.title ? { title: stream.tags.title } : {}),
      default: stream.disposition?.default === 1,
      forced: stream.disposition?.forced === 1,
    }];
  }).sort((left, right) => left.index - right.index);
}

export function selectEmbeddedTextSubtitle(
  tracks: readonly EmbeddedSubtitleTrack[],
  preferredLanguage?: string,
): EmbeddedSubtitleTrack | null {
  const textTracks = tracks.filter((track) => track.kind === 'text');
  if (textTracks.length === 0) return null;
  const aliases = preferredLanguage && preferredLanguage !== 'auto' ? languageAliases(preferredLanguage) : null;
  return [...textTracks].sort((left, right) => {
    const score = (track: EmbeddedSubtitleTrack) =>
      (track.language && aliases?.has(track.language.toLowerCase()) ? 100 : 0) +
      (track.default ? 20 : 0) - (track.forced ? 5 : 0);
    return score(right) - score(left) || left.index - right.index;
  })[0] ?? null;
}

export async function extractEmbeddedTextSubtitle(
  mediaPath: string,
  ffmpegPath: string,
  track: EmbeddedSubtitleTrack,
  outputPath: string,
  run: ProcessRunner,
  signal?: AbortSignal,
): Promise<AITranscriptionResult> {
  if (track.kind !== 'text') throw new Error('Only text subtitle tracks can be extracted without OCR.');
  await run({
    executablePath: ffmpegPath,
    args: ['-nostdin', '-y', '-i', mediaPath, '-map', `0:${track.index}`, '-c:s', 'webvtt', '-f', 'webvtt', outputPath],
    cwd: dirname(mediaPath),
    timeoutMs: 30 * 60_000,
    maxOutputBytes: 8 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  const transcript = parseCaptions(await readFile(outputPath, 'utf8'), 'webvtt');
  return { ...transcript, ...(track.language ? { language: track.language } : {}) };
}
