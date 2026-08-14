import type {
  AICompletion,
  AIInvocationContext,
  AIProvider,
  AIProviderConfig,
} from '@oldfolio/domain';
import { z } from 'zod';

import { createPromptDataBoundary } from './prompt-boundary.js';
import { parseStructuredOutput } from './structured-output.js';
import {
  SUMMARY_TEMPLATES,
  classifySummaryTemplate,
  type SummaryTemplate,
} from './templates.js';

const MAX_SOURCE_CHARACTERS = 200_000;
const MAX_PROMPT_DATA_CHARACTERS = 5_000;
const MAX_SEGMENT_PART_CHARACTERS = 2_500;
const MAX_OUTPUT_TOKENS_PER_CALL = 1_536;
const PROMPT_VERSION = 'transcript-summary-v2-hierarchical';

export interface TranscriptSummarySegment {
  readonly startMs: number;
  readonly endMs?: number;
  readonly text: string;
  readonly speaker?: string;
}

export interface PrepareTranscriptSummaryInput {
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly title: string;
  readonly resource: string;
  readonly segments: readonly TranscriptSummarySegment[];
}

export interface SummaryEvidence {
  readonly id: string;
  readonly startMs: number;
  readonly endMs?: number;
  readonly text: string;
  readonly speaker?: string;
}

const citedTextSchema = z.object({
  text: z.string().trim().min(1).max(4_000),
  evidenceIds: z.array(z.string().trim().min(1)).min(1).max(8),
}).strict();

const conceptSchema = z.object({
  name: z.string().trim().min(1).max(120),
  explanation: z.string().trim().min(1).max(4_000),
  evidenceIds: z.array(z.string().trim().min(1)).min(1).max(8),
}).strict();

export const transcriptSummarySchema = z.object({
  title: z.string().trim().min(1).max(200),
  overview: citedTextSchema,
  keyPoints: z.array(citedTextSchema).min(1).max(16),
  concepts: z.array(conceptSchema).max(12),
}).strict();

export type GeneratedTranscriptSummary = z.infer<typeof transcriptSummarySchema>;

export interface PreparedTranscriptSummary {
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly title: string;
  readonly resource: string;
  readonly suggestedTemplate: SummaryTemplate;
  readonly templateConfidence: number;
  readonly evidence: readonly SummaryEvidence[];
  readonly sourcePayload: string;
  readonly sourceCharacters: number;
  readonly estimatedInputTokens: number;
  readonly processingMode: 'direct' | 'hierarchical';
  readonly estimatedModelCalls: number;
}

export interface GenerateTranscriptSummaryResult {
  readonly summary: GeneratedTranscriptSummary;
  readonly completion: AICompletion;
  readonly template: SummaryTemplate;
  readonly promptVersion: string;
}

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'overview', 'keyPoints', 'concepts'],
  properties: {
    title: { type: 'string' },
    overview: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'evidenceIds'],
      properties: {
        text: { type: 'string' },
        evidenceIds: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
    },
    keyPoints: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'evidenceIds'],
        properties: {
          text: { type: 'string' },
          evidenceIds: { type: 'array', minItems: 1, items: { type: 'string' } },
        },
      },
    },
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'explanation', 'evidenceIds'],
        properties: {
          name: { type: 'string' },
          explanation: { type: 'string' },
          evidenceIds: { type: 'array', minItems: 1, items: { type: 'string' } },
        },
      },
    },
  },
} as const;

const templateGuidance: Readonly<Record<SummaryTemplate, string>> = {
  course: 'Organize learning objectives, core explanations, examples, and review points.',
  interview: 'Distinguish speakers, questions, claims, and areas of agreement or disagreement.',
  podcast: 'Capture the episode thesis, recurring themes, stories, and practical takeaways.',
  tutorial: 'Preserve prerequisites, ordered steps, warnings, and verification criteria.',
  meeting: 'Capture decisions, unresolved questions, owners, and action items without inventing assignments.',
  'news-commentary': 'Separate reported facts, interpretation, forecasts, and uncertainty.',
  debate: 'Represent competing claims, supporting evidence, rebuttals, and unresolved disputes fairly.',
  review: 'Capture evaluation criteria, strengths, weaknesses, comparisons, and recommendations.',
};

function assertTemplate(value: string): asserts value is SummaryTemplate {
  if (!(SUMMARY_TEMPLATES as readonly string[]).includes(value)) {
    throw new Error(`Unsupported summary template: ${value}`);
  }
}

function evidenceId(index: number): string {
  return `segment-${String(index + 1).padStart(5, '0')}`;
}

interface PromptEvidence extends SummaryEvidence {
  readonly part?: number;
}

function transcriptPayload(
  title: string,
  resource: string,
  segments: readonly PromptEvidence[],
): string {
  return JSON.stringify({ title, resource, segments });
}

function splitEvidenceForPrompt(evidence: readonly SummaryEvidence[]): readonly PromptEvidence[] {
  return evidence.flatMap((item) => {
    if (item.text.length <= MAX_SEGMENT_PART_CHARACTERS) return [item];
    const parts: PromptEvidence[] = [];
    for (let offset = 0; offset < item.text.length; offset += MAX_SEGMENT_PART_CHARACTERS) {
      parts.push({
        ...item,
        text: item.text.slice(offset, offset + MAX_SEGMENT_PART_CHARACTERS),
        part: parts.length + 1,
      });
    }
    return parts;
  });
}

function buildTranscriptChunks(
  title: string,
  resource: string,
  evidence: readonly SummaryEvidence[],
): readonly { readonly payload: string; readonly evidenceIds: readonly string[] }[] {
  const parts = splitEvidenceForPrompt(evidence);
  const chunks: { readonly payload: string; readonly evidenceIds: readonly string[] }[] = [];
  let current: PromptEvidence[] = [];

  const pushCurrent = (): void => {
    if (current.length === 0) return;
    chunks.push({
      payload: transcriptPayload(title, resource, current),
      evidenceIds: [...new Set(current.map((item) => item.id))],
    });
    current = [];
  };

  for (const part of parts) {
    const candidate = [...current, part];
    if (current.length > 0 && transcriptPayload(title, resource, candidate).length > MAX_PROMPT_DATA_CHARACTERS) {
      pushCurrent();
    }
    current.push(part);
    const payload = transcriptPayload(title, resource, current);
    if (payload.length > MAX_PROMPT_DATA_CHARACTERS) {
      throw new Error('A transcript segment is too large to fit in the safe local-model prompt budget.');
    }
  }
  pushCurrent();
  return chunks;
}

export function prepareTranscriptSummary(input: PrepareTranscriptSummaryInput): PreparedTranscriptSummary {
  if (!input.sourcePath.trim() || !input.sourceRevision.trim()) throw new Error('A source path and revision are required.');
  if (!input.resource.trim()) throw new Error('A transcript media resource is required.');
  if (input.segments.length === 0) throw new Error('A transcript requires at least one evidence segment.');

  const evidence = input.segments.map((segment, index) => {
    if (!Number.isSafeInteger(segment.startMs) || segment.startMs < 0 || !segment.text.trim()) {
      throw new Error(`Invalid transcript segment at index ${index}.`);
    }
    return Object.freeze({
      id: evidenceId(index),
      startMs: segment.startMs,
      ...(segment.endMs === undefined ? {} : { endMs: segment.endMs }),
      text: segment.text.trim(),
      ...(segment.speaker?.trim() ? { speaker: segment.speaker.trim() } : {}),
    });
  });
  const sourcePayload = JSON.stringify({
    title: input.title,
    resource: input.resource,
    segments: evidence,
  });
  if (sourcePayload.length > MAX_SOURCE_CHARACTERS) {
    throw new Error(
      `Transcript payload is ${sourcePayload.length.toLocaleString()} characters; the current summary limit is ${MAX_SOURCE_CHARACTERS.toLocaleString()}.`,
    );
  }
  const classification = classifySummaryTemplate({
    title: input.title,
    transcriptSample: evidence.slice(0, 30).map((item) => item.text).join('\n'),
    sourceKind: /\.(?:mp3|m4a|aac|flac|ogg|opus|wav)$/iu.test(input.resource) ? 'audio' : 'video',
    participantCount: new Set(evidence.flatMap((item) => item.speaker ? [item.speaker] : [])).size,
  });
  const chunks = buildTranscriptChunks(input.title, input.resource, evidence);
  return Object.freeze({
    sourcePath: input.sourcePath,
    sourceRevision: input.sourceRevision,
    title: input.title,
    resource: input.resource,
    suggestedTemplate: classification.template,
    templateConfidence: classification.confidence,
    evidence: Object.freeze(evidence),
    sourcePayload,
    sourceCharacters: sourcePayload.length,
    // A deliberately conservative multilingual estimate for disclosure, not billing.
    estimatedInputTokens: Math.ceil(sourcePayload.length / 2),
    processingMode: chunks.length === 1 ? 'direct' : 'hierarchical',
    estimatedModelCalls: chunks.length === 1 ? 1 : (chunks.length * 2) - 1,
  });
}

function summaryEvidenceIds(summary: GeneratedTranscriptSummary): readonly string[] {
  return [...new Set([
    ...summary.overview.evidenceIds,
    ...summary.keyPoints.flatMap((item) => item.evidenceIds),
    ...summary.concepts.flatMap((item) => item.evidenceIds),
  ])];
}

function validateEvidenceReferences(summary: GeneratedTranscriptSummary, allowedEvidenceIds: Iterable<string>): void {
  const allowed = new Set(allowedEvidenceIds);
  const references = [
    ...summary.overview.evidenceIds,
    ...summary.keyPoints.flatMap((item) => item.evidenceIds),
    ...summary.concepts.flatMap((item) => item.evidenceIds),
  ];
  for (const id of references) {
    if (!allowed.has(id)) throw new Error(`The model cited unknown transcript evidence "${id}".`);
  }
}

function compactSummary(summary: GeneratedTranscriptSummary): object {
  return {
    title: summary.title.slice(0, 200),
    overview: {
      text: summary.overview.text.slice(0, 300),
      evidenceIds: summary.overview.evidenceIds.slice(0, 3),
    },
    keyPoints: summary.keyPoints.slice(0, 4).map((item) => ({
      text: item.text.slice(0, 140),
      evidenceIds: item.evidenceIds.slice(0, 3),
    })),
    concepts: summary.concepts.slice(0, 2).map((item) => ({
      name: item.name.slice(0, 80),
      explanation: item.explanation.slice(0, 140),
      evidenceIds: item.evidenceIds.slice(0, 3),
    })),
  };
}

async function completeSummary(
  provider: AIProvider,
  config: AIProviderConfig,
  task: string,
  sourceId: string,
  mediaType: string,
  content: string,
  allowedEvidenceIds: Iterable<string>,
  context?: AIInvocationContext,
): Promise<{ readonly summary: GeneratedTranscriptSummary; readonly completion: AICompletion }> {
  const boundary = createPromptDataBoundary(task, [{ sourceId, mediaType, content }]);
  const completion = await provider.complete(config, {
    model: config.model,
    messages: boundary.messages,
    temperature: 0.2,
    maxOutputTokens: MAX_OUTPUT_TOKENS_PER_CALL,
    responseFormat: 'json',
    responseSchema,
  }, context);
  const summary = parseStructuredOutput(completion.content, transcriptSummarySchema);
  validateEvidenceReferences(summary, allowedEvidenceIds);
  return { summary, completion };
}

function aggregateCompletion(finalCompletion: AICompletion, completions: readonly AICompletion[]): AICompletion {
  const inputTokens = completions.reduce((total, completion) => total + (completion.usage?.inputTokens ?? 0), 0);
  const outputTokens = completions.reduce((total, completion) => total + (completion.usage?.outputTokens ?? 0), 0);
  const hasInputUsage = completions.some((completion) => completion.usage?.inputTokens !== undefined);
  const hasOutputUsage = completions.some((completion) => completion.usage?.outputTokens !== undefined);
  return {
    ...finalCompletion,
    ...(!hasInputUsage && !hasOutputUsage ? {} : {
      usage: {
        ...(hasInputUsage ? { inputTokens } : {}),
        ...(hasOutputUsage ? { outputTokens } : {}),
      },
    }),
  };
}

export async function generateTranscriptSummary(
  provider: AIProvider,
  config: AIProviderConfig,
  prepared: PreparedTranscriptSummary,
  requestedTemplate: SummaryTemplate = prepared.suggestedTemplate,
  context?: AIInvocationContext,
): Promise<GenerateTranscriptSummaryResult> {
  assertTemplate(requestedTemplate);
  if (!config.model.trim()) throw new Error('An AI model must be selected before generating a summary.');
  const task = [
    `Create a ${requestedTemplate} summary in the language primarily used by the transcript.`,
    templateGuidance[requestedTemplate],
    'Return only the requested JSON object.',
    'Every overview, key point, and concept must cite one or more evidenceIds supplied in the source data.',
    'Do not introduce facts that are not supported by those evidence segments.',
  ].join(' ');
  const chunks = buildTranscriptChunks(prepared.title, prepared.resource, prepared.evidence);
  const completions: AICompletion[] = [];
  let level: GeneratedTranscriptSummary[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const result = await completeSummary(
      provider,
      config,
      `${task} This is transcript batch ${index + 1} of ${chunks.length}; summarize only this batch.`,
      `${prepared.sourcePath}#batch-${index + 1}`,
      'application/vnd.oldfolio.transcript+json',
      chunk.payload,
      chunk.evidenceIds,
      context,
    );
    completions.push(result.completion);
    level.push(result.summary);
  }

  while (level.length > 1) {
    const nextLevel: GeneratedTranscriptSummary[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const pair = level.slice(index, index + 2);
      if (pair.length === 1) {
        nextLevel.push(pair[0]!);
        continue;
      }
      const allowedEvidenceIds = [...new Set(pair.flatMap(summaryEvidenceIds))];
      const content = JSON.stringify({ title: prepared.title, partialSummaries: pair.map(compactSummary) });
      if (content.length > MAX_PROMPT_DATA_CHARACTERS) {
        throw new Error('Intermediate summaries exceeded the safe local-model prompt budget.');
      }
      const result = await completeSummary(
        provider,
        config,
        `${task} Merge these partial summaries into one coherent summary. Preserve their original evidenceIds.`,
        `${prepared.sourcePath}#merge-${index / 2 + 1}`,
        'application/vnd.oldfolio.partial-summaries+json',
        content,
        allowedEvidenceIds,
        context,
      );
      completions.push(result.completion);
      nextLevel.push(result.summary);
    }
    level = nextLevel;
  }

  const summary = level[0]!;
  validateEvidenceReferences(summary, prepared.evidence.map((item) => item.id));
  const completion = aggregateCompletion(completions.at(-1)!, completions);
  return Object.freeze({ summary, completion, template: requestedTemplate, promptVersion: PROMPT_VERSION });
}
