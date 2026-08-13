import type { AITranscriptSegment, AITranscriptionResult } from '@oldfolio/domain';

export type CaptionFormat = 'srt' | 'webvtt';

export class CaptionParseError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line === undefined ? message : `${message} at line ${line}`);
    this.name = 'CaptionParseError';
  }
}

const TIMING = /^(?<start>(?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+(?<end>(?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$/u;

function timestampToMs(value: string): number {
  const normalized = value.replace(',', '.');
  const parts = normalized.split(':');
  if (parts.length !== 2 && parts.length !== 3) throw new CaptionParseError(`Invalid timestamp: ${value}`);
  const secondsPart = parts.at(-1)?.split('.') ?? [];
  const seconds = Number(secondsPart[0]);
  const milliseconds = Number(secondsPart[1]);
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (
    ![hours, minutes, seconds, milliseconds].every(Number.isFinite) ||
    minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59 || milliseconds < 0 || milliseconds > 999
  ) {
    throw new CaptionParseError(`Invalid timestamp: ${value}`);
  }
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
}

function decodeCaptionText(value: string): { readonly text: string; readonly speaker?: string } {
  const voice = value.match(/^<v(?:\.[^ >]+)*\s+([^>]+)>/iu)?.[1]?.trim();
  const text = value
    .replaceAll(/<[^>]*>/gu, '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll(/[ \t]+/gu, ' ')
    .trim();
  return { text, ...(voice ? { speaker: voice } : {}) };
}

function normalizeInput(source: string): string[] {
  return source.replace(/^\uFEFF/u, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
}

export function parseCaptions(source: string, format?: CaptionFormat): AITranscriptionResult {
  const lines = normalizeInput(source);
  const detected = format ?? (lines[0]?.trim().startsWith('WEBVTT') === true ? 'webvtt' : 'srt');
  let cursor = detected === 'webvtt' ? 1 : 0;
  const segments: AITranscriptSegment[] = [];

  while (cursor < lines.length) {
    while (cursor < lines.length && !lines[cursor]?.trim()) cursor += 1;
    if (cursor >= lines.length) break;
    if (detected === 'webvtt' && /^(?:NOTE|STYLE|REGION)(?:\s|$)/u.test(lines[cursor]?.trim() ?? '')) {
      while (cursor < lines.length && lines[cursor]?.trim()) cursor += 1;
      continue;
    }
    let timing = lines[cursor]?.trim().match(TIMING);
    if (!timing) {
      cursor += 1;
      timing = lines[cursor]?.trim().match(TIMING);
    }
    if (!timing?.groups) throw new CaptionParseError('Expected a caption timing line', cursor + 1);
    const startMs = timestampToMs(timing.groups.start ?? '');
    const endMs = timestampToMs(timing.groups.end ?? '');
    if (endMs <= startMs) throw new CaptionParseError('Caption end must be after its start', cursor + 1);
    cursor += 1;
    const textLines: string[] = [];
    while (cursor < lines.length && lines[cursor]?.trim()) {
      textLines.push(lines[cursor]?.trim() ?? '');
      cursor += 1;
    }
    const decoded = decodeCaptionText(textLines.join('\n'));
    if (decoded.text) segments.push({ startMs, endMs, text: decoded.text, ...(decoded.speaker ? { speaker: decoded.speaker } : {}) });
  }
  if (segments.length === 0) throw new CaptionParseError('Caption document contains no cues');
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (previous && current && current.startMs < previous.startMs) {
      throw new CaptionParseError('Caption cues must be ordered by start time');
    }
  }
  return { text: segments.map((segment) => segment.text).join('\n'), segments };
}
