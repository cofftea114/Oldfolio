import { createHash } from 'node:crypto';
import type { AITranscriptionResult, OkfConceptFrontmatter } from '@oldfolio/domain';
import { serializeNewOkfConcept } from '@oldfolio/okf';

export interface CompileTranscriptInput {
  readonly sourceId: string;
  readonly sourceHash: string;
  readonly sourceResource: string;
  readonly sourceTitle?: string;
  readonly transcript: AITranscriptionResult;
  readonly generatedAt: string;
  readonly generator: string;
}

export interface CompiledTranscriptDocument {
  readonly id: string;
  readonly path: string;
  readonly content: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeId(value: string): string {
  return value.normalize('NFC').replaceAll(/[^a-zA-Z0-9._-]/gu, '-').replaceAll(/-+/gu, '-').slice(0, 80);
}

function displayTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function timeResource(resource: string, milliseconds: number): string {
  const separator = resource.includes('#') ? '&' : '#';
  return `${resource}${separator}t=${(milliseconds / 1_000).toFixed(3)}`;
}

function markdownText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

/** Compiles timestamped transcript evidence into a strict OKF Transcript concept. */
export function compileTranscriptDocument(input: CompileTranscriptInput): CompiledTranscriptDocument {
  if (input.transcript.segments.length === 0) throw new Error('A transcript requires at least one segment.');
  const transcriptHash = sha256(JSON.stringify(input.transcript.segments));
  const lineage = safeId(input.sourceId);
  if (!lineage) throw new Error('Transcript source id is invalid.');
  const id = `transcript-${lineage}-${transcriptHash.slice(0, 16)}`;
  const path = `bundles/personal/wiki/transcripts/${lineage}/${transcriptHash.slice(0, 16)}.md`;
  const title = `${input.sourceTitle?.trim() || 'Imported media'} — Transcript`;
  const frontmatter: OkfConceptFrontmatter = {
    type: 'Transcript',
    title,
    description: 'Timestamped transcript derived from an immutable Oldfolio source snapshot.',
    resource: input.sourceResource,
    sources: [{ resource: input.sourceResource, id: input.sourceId, title: input.sourceTitle }],
    status: 'draft',
    generated: { by: input.generator, at: input.generatedAt },
    oldfolio: {
      id,
      source_id: input.sourceId,
      source_hash: input.sourceHash,
      transcript_hash: transcriptHash,
      language: input.transcript.language ?? 'und',
      segment_count: input.transcript.segments.length,
    },
  };
  const segments = input.transcript.segments.map((segment) => {
    const label = displayTime(segment.startMs);
    const speaker = segment.speaker ? ` **${markdownText(segment.speaker)}:**` : '';
    return `- [${label}](${timeResource(input.sourceResource, segment.startMs)})${speaker} ${markdownText(segment.text)}`;
  });
  return {
    id,
    path,
    content: serializeNewOkfConcept({
      frontmatter,
      body: [`# ${markdownText(title)}`, '', ...segments, ''].join('\n'),
    }),
  };
}
