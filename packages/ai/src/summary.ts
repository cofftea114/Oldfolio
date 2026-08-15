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
const MAX_DOCUMENT_WINDOW_CHARACTERS = 3_500;
const MAX_SEGMENT_PART_CHARACTERS = 2_500;
const MAX_WORKING_NOTES_CHARACTERS = 1_800;
const MAX_FINAL_EVIDENCE_CHARACTERS = 4_800;
const MAX_READER_OUTPUT_TOKENS = 1_024;
const MAX_OUTPUT_TOKENS_PER_CALL = 1_536;
const PROMPT_VERSION = 'transcript-summary-v3-document-reader';

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
  readonly workingDocumentPath: string;
  readonly workingDocumentContent: string;
  readonly sourceCharacters: number;
  readonly estimatedInputTokens: number;
  readonly processingMode: 'direct' | 'document-reader';
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

const readerNotesSchema = z.object({
  notes: z.string().trim().min(1).max(MAX_WORKING_NOTES_CHARACTERS),
  evidenceIds: z.array(z.string().trim().min(1)).min(1).max(48),
}).strict();

const readerNotesResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['notes', 'evidenceIds'],
  properties: {
    notes: { type: 'string' },
    evidenceIds: { type: 'array', minItems: 1, maxItems: 48, items: { type: 'string' } },
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

interface DocumentWindow {
  readonly content: string;
  readonly evidenceIds: readonly string[];
}

function displayTimestamp(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const millisecondsPart = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millisecondsPart).padStart(3, '0')}`;
}

function evidenceLine(item: PromptEvidence): string {
  const range = item.endMs === undefined
    ? displayTimestamp(item.startMs)
    : `${displayTimestamp(item.startMs)}-${displayTimestamp(item.endMs)}`;
  const speaker = item.speaker ? ` ${item.speaker}:` : '';
  const part = item.part === undefined ? '' : ` part=${item.part}`;
  return `[${item.id} ${range}${part}]${speaker} ${item.text}`;
}

export function createTranscriptWorkingDocument(prepared: Pick<
  PreparedTranscriptSummary,
  'title' | 'resource' | 'sourcePath' | 'sourceRevision' | 'evidence'
>): string {
  return [
    '# Oldfolio transcript working document',
    `source: ${prepared.sourcePath}`,
    `revision: ${prepared.sourceRevision}`,
    `title: ${prepared.title}`,
    `resource: ${prepared.resource}`,
    '',
    ...splitEvidenceForPrompt(prepared.evidence).map(evidenceLine),
    '',
  ].join('\n');
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

function buildDocumentWindows(evidence: readonly SummaryEvidence[]): readonly DocumentWindow[] {
  const parts = splitEvidenceForPrompt(evidence);
  const windows: DocumentWindow[] = [];
  let currentLines: string[] = [];
  let currentIds: string[] = [];

  const pushCurrent = (): void => {
    if (currentLines.length === 0) return;
    windows.push({
      content: currentLines.join('\n'),
      evidenceIds: [...new Set(currentIds)],
    });
    currentLines = [];
    currentIds = [];
  };

  for (const part of parts) {
    const line = evidenceLine(part);
    if (currentLines.length > 0 && [...currentLines, line].join('\n').length > MAX_DOCUMENT_WINDOW_CHARACTERS) pushCurrent();
    if (line.length > MAX_DOCUMENT_WINDOW_CHARACTERS) throw new Error('A transcript line exceeds the document-reader window limit.');
    currentLines.push(line);
    currentIds.push(part.id);
  }
  pushCurrent();
  return windows;
}

export function prepareTranscriptSummary(input: PrepareTranscriptSummaryInput): PreparedTranscriptSummary {
  if (!input.sourcePath.trim() || !input.sourceRevision.trim()) throw new Error('A source path and revision are required.');
  if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(input.sourceRevision)) throw new Error('The source revision is not safe for a working-document id.');
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
  const classification = classifySummaryTemplate({
    title: input.title,
    transcriptSample: evidence.slice(0, 30).map((item) => item.text).join('\n'),
    sourceKind: /\.(?:mp3|m4a|aac|flac|ogg|opus|wav)$/iu.test(input.resource) ? 'audio' : 'video',
    participantCount: new Set(evidence.flatMap((item) => item.speaker ? [item.speaker] : [])).size,
  });
  const workingDocumentPath = `.oldfolio/cache/ai-inputs/${input.sourceRevision}.txt`;
  const workingDocumentContent = createTranscriptWorkingDocument({
    title: input.title,
    resource: input.resource,
    sourcePath: input.sourcePath,
    sourceRevision: input.sourceRevision,
    evidence,
  });
  if (workingDocumentContent.length > MAX_SOURCE_CHARACTERS) {
    throw new Error(
      `Transcript working document is ${workingDocumentContent.length.toLocaleString()} characters; the current summary limit is ${MAX_SOURCE_CHARACTERS.toLocaleString()}.`,
    );
  }
  const windows = buildDocumentWindows(evidence);
  return Object.freeze({
    sourcePath: input.sourcePath,
    sourceRevision: input.sourceRevision,
    title: input.title,
    resource: input.resource,
    suggestedTemplate: classification.template,
    templateConfidence: classification.confidence,
    evidence: Object.freeze(evidence),
    workingDocumentPath,
    workingDocumentContent,
    sourceCharacters: workingDocumentContent.length,
    // A deliberately conservative multilingual estimate for disclosure, not billing.
    estimatedInputTokens: Math.ceil(workingDocumentContent.length / 2),
    processingMode: windows.length === 1 ? 'direct' : 'document-reader',
    estimatedModelCalls: windows.length === 1 ? 1 : windows.length + 1,
  });
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

function finalEvidencePayload(
  prepared: PreparedTranscriptSummary,
  evidenceIds: readonly string[],
  notes: string,
): string {
  const allowed = new Set(evidenceIds);
  const selected: object[] = [];
  for (const item of prepared.evidence) {
    if (!allowed.has(item.id)) continue;
    const candidate = [...selected, {
      id: item.id,
      startMs: item.startMs,
      ...(item.endMs === undefined ? {} : { endMs: item.endMs }),
      text: item.text.slice(0, 320),
      ...(item.speaker === undefined ? {} : { speaker: item.speaker }),
    }];
    const serialized = JSON.stringify({ documentPath: prepared.workingDocumentPath, notes, evidence: candidate });
    if (serialized.length > MAX_FINAL_EVIDENCE_CHARACTERS) break;
    selected.push(candidate.at(-1)!);
  }
  if (selected.length === 0) throw new Error('The document reader did not retain any usable transcript evidence.');
  return JSON.stringify({ documentPath: prepared.workingDocumentPath, notes, evidence: selected });
}

async function readDocumentWindow(
  provider: AIProvider,
  config: AIProviderConfig,
  prepared: PreparedTranscriptSummary,
  window: DocumentWindow,
  windowIndex: number,
  windowCount: number,
  previousNotes: string,
  previousEvidenceIds: readonly string[],
  context?: AIInvocationContext,
): Promise<{
  readonly notes: string;
  readonly evidenceIds: readonly string[];
  readonly completion: AICompletion;
}> {
  const allowedEvidenceIds = [...new Set([...previousEvidenceIds, ...window.evidenceIds])];
  const task = [
    `Read window ${windowIndex + 1} of ${windowCount} from the transcript working document.`,
    'Update one concise global set of working notes; integrate new information with earlier notes instead of summarizing this window independently.',
    'Preserve cross-section arguments, changes of position, contradictions, examples, and unresolved questions.',
    `Keep notes under ${MAX_WORKING_NOTES_CHARACTERS} characters.`,
    'Return only JSON. evidenceIds may contain only segment ids present in prior notes or this document window.',
  ].join(' ');
  const boundary = createPromptDataBoundary(task, [
    {
      sourceId: `${prepared.workingDocumentPath}#window-${windowIndex + 1}`,
      mediaType: 'text/plain',
      content: window.content,
    },
    {
      sourceId: `${prepared.workingDocumentPath}#working-notes`,
      mediaType: 'application/json',
      content: JSON.stringify({ notes: previousNotes, evidenceIds: previousEvidenceIds }),
    },
  ]);
  const completion = await provider.complete(config, {
    model: config.model,
    messages: boundary.messages,
    temperature: 0.1,
    maxOutputTokens: MAX_READER_OUTPUT_TOKENS,
    responseFormat: 'json',
    responseSchema: readerNotesResponseSchema,
  }, context);
  const result = parseStructuredOutput(completion.content, readerNotesSchema);
  for (const id of result.evidenceIds) {
    if (!allowedEvidenceIds.includes(id)) throw new Error(`The document reader cited unknown transcript evidence "${id}".`);
  }
  return { notes: result.notes, evidenceIds: result.evidenceIds, completion };
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
  const windows = buildDocumentWindows(prepared.evidence);
  const completions: AICompletion[] = [];
  if (windows.length === 1) {
    const result = await completeSummary(
      provider,
      config,
      task,
      prepared.workingDocumentPath,
      'text/plain',
      prepared.workingDocumentContent,
      prepared.evidence.map((item) => item.id),
      context,
    );
    return Object.freeze({
      summary: result.summary,
      completion: result.completion,
      template: requestedTemplate,
      promptVersion: PROMPT_VERSION,
    });
  }

  let notes = '';
  let retainedEvidenceIds: readonly string[] = [];
  for (const [index, window] of windows.entries()) {
    const read = await readDocumentWindow(
      provider,
      config,
      prepared,
      window,
      index,
      windows.length,
      notes,
      retainedEvidenceIds,
      context,
    );
    notes = read.notes;
    retainedEvidenceIds = read.evidenceIds;
    completions.push(read.completion);
  }

  const final = await completeSummary(
    provider,
    config,
    `${task} Use the global working notes produced after reading the complete document, and return the final synthesis now.`,
    `${prepared.workingDocumentPath}#final-synthesis`,
    'application/vnd.oldfolio.document-notes+json',
    finalEvidencePayload(prepared, retainedEvidenceIds, notes),
    retainedEvidenceIds,
    context,
  );
  completions.push(final.completion);
  const summary = final.summary;
  validateEvidenceReferences(summary, prepared.evidence.map((item) => item.id));
  const completion = aggregateCompletion(completions.at(-1)!, completions);
  return Object.freeze({ summary, completion, template: requestedTemplate, promptVersion: PROMPT_VERSION });
}
