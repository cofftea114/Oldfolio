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
const PROMPT_VERSION = 'transcript-summary-v1';

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
  });
}

function validateEvidenceReferences(summary: GeneratedTranscriptSummary, evidence: readonly SummaryEvidence[]): void {
  const allowed = new Set(evidence.map((item) => item.id));
  const references = [
    ...summary.overview.evidenceIds,
    ...summary.keyPoints.flatMap((item) => item.evidenceIds),
    ...summary.concepts.flatMap((item) => item.evidenceIds),
  ];
  for (const id of references) {
    if (!allowed.has(id)) throw new Error(`The model cited unknown transcript evidence "${id}".`);
  }
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
  const boundary = createPromptDataBoundary(task, [{
    sourceId: prepared.sourcePath,
    mediaType: 'application/vnd.oldfolio.transcript+json',
    content: prepared.sourcePayload,
  }]);
  const completion = await provider.complete(config, {
    model: config.model,
    messages: boundary.messages,
    temperature: 0.2,
    maxOutputTokens: 4_096,
    responseFormat: 'json',
    responseSchema,
  }, context);
  const summary = parseStructuredOutput(completion.content, transcriptSummarySchema);
  validateEvidenceReferences(summary, prepared.evidence);
  return Object.freeze({ summary, completion, template: requestedTemplate, promptVersion: PROMPT_VERSION });
}
