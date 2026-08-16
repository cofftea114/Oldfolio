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
const MAX_WORKING_NOTES_CHARACTERS = 1_400;
const MAX_FINAL_CHECKPOINT_CHARACTERS = 4_000;
const MAX_FINAL_SYNTHESIS_CHARACTERS = 6_500;
const MAX_READER_EVIDENCE_IDS = 24;
const MAX_SUMMARY_EVIDENCE_IDS = 1;
const MAX_READER_OUTPUT_TOKENS = 1_280;
const MAX_OUTPUT_TOKENS_PER_CALL = 2_560;
const PROMPT_VERSION = 'transcript-summary-v7-thematic-notes';

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
  evidenceIds: z.array(z.string().trim().min(1)).min(1).max(MAX_SUMMARY_EVIDENCE_IDS),
}).strict();

const sectionSchema = z.object({
  heading: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(4_000),
  points: z.array(z.string().trim().min(1).max(2_000)).min(1).max(6),
  evidenceIds: z.array(z.string().trim().min(1)).min(1).max(MAX_SUMMARY_EVIDENCE_IDS),
}).strict();

export const transcriptSummarySchema = z.object({
  title: z.string().trim().min(1).max(200),
  overview: citedTextSchema,
  sections: z.array(sectionSchema).min(1).max(8),
  takeaways: z.array(z.string().trim().min(1).max(2_000)).min(1).max(6),
  uncertainties: z.array(z.string().trim().min(1).max(1_000)).max(6),
}).strict();

export type GeneratedTranscriptSummary = z.infer<typeof transcriptSummarySchema>;

const modelCitedTextSchema = citedTextSchema.extend({
  evidenceIds: z.array(z.string().trim().min(1)).min(1),
}).strict();

const modelSectionSchema = sectionSchema.extend({
  evidenceIds: z.array(z.string().trim().min(1)).min(1),
}).strict();

const modelTranscriptSummarySchema = transcriptSummarySchema.extend({
  overview: modelCitedTextSchema,
  sections: z.array(modelSectionSchema).min(1).max(8),
}).strict();

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

function evidenceIdsResponseSchema(allowedEvidenceIds: readonly string[], maxItems: number) {
  return {
    type: 'array',
    minItems: 1,
    maxItems,
    items: { type: 'string', enum: allowedEvidenceIds },
  } as const;
}

function summaryResponseSchema(allowedEvidenceIds: readonly string[], minimumSections: number) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'overview', 'sections', 'takeaways', 'uncertainties'],
    properties: {
      title: { type: 'string' },
      overview: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'evidenceIds'],
        properties: {
          text: { type: 'string' },
          evidenceIds: evidenceIdsResponseSchema(allowedEvidenceIds, MAX_SUMMARY_EVIDENCE_IDS),
        },
      },
      sections: {
        type: 'array',
        minItems: minimumSections,
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['heading', 'summary', 'points', 'evidenceIds'],
          properties: {
            heading: { type: 'string' },
            summary: { type: 'string' },
            points: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              items: { type: 'string' },
            },
            evidenceIds: evidenceIdsResponseSchema(allowedEvidenceIds, MAX_SUMMARY_EVIDENCE_IDS),
          },
        },
      },
      takeaways: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: { type: 'string' },
      },
      uncertainties: {
        type: 'array',
        maxItems: 6,
        items: { type: 'string' },
      },
    },
  } as const;
}

const readerNotesSchema = z.object({
  notes: z.string().trim().min(1).max(MAX_WORKING_NOTES_CHARACTERS),
  evidenceIds: z.array(z.string().trim().min(1)).min(1).max(MAX_READER_EVIDENCE_IDS),
}).strict();

const modelReaderNotesSchema = readerNotesSchema.extend({
  evidenceIds: z.array(z.string().trim().min(1)).min(1),
}).strict();

function readerNotesResponseSchema(allowedEvidenceIds: readonly string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['notes', 'evidenceIds'],
    properties: {
      notes: { type: 'string', maxLength: MAX_WORKING_NOTES_CHARACTERS },
      evidenceIds: evidenceIdsResponseSchema(allowedEvidenceIds, MAX_READER_EVIDENCE_IDS),
    },
  } as const;
}

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

type SummaryOutputLanguage = 'Simplified Chinese' | 'English';

function detectSummaryOutputLanguage(prepared: Pick<PreparedTranscriptSummary, 'title' | 'evidence'>): SummaryOutputLanguage {
  const sample = `${prepared.title}\n${prepared.evidence.map((item) => item.text).join('\n')}`;
  const hanCharacters = sample.match(/[\p{Script=Han}]/gu)?.length ?? 0;
  const latinCharacters = sample.match(/[a-zA-Z]/gu)?.length ?? 0;
  return hanCharacters >= Math.max(8, Math.ceil(latinCharacters / 2)) ? 'Simplified Chinese' : 'English';
}

function outputLanguageInstruction(language: SummaryOutputLanguage): string {
  if (language === 'Simplified Chinese') {
    return 'Every generated text field must use Simplified Chinese, including working notes, title, overview, key points, concept names, and explanations. Never answer in English.';
  }
  return 'Every generated text field must use English, including working notes, title, overview, key points, concept names, and explanations.';
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
    ...summary.sections.flatMap((item) => item.evidenceIds),
  ];
  for (const id of references) {
    if (!allowed.has(id)) throw new Error(`The model cited unknown transcript evidence "${id}".`);
  }
}

function selectRepresentativeEvidenceIds(
  evidenceIds: readonly string[],
  maximum: number,
): readonly string[] {
  const unique = [...new Set(evidenceIds)];
  if (unique.length <= maximum) return unique;
  if (maximum === 1) return [unique[0]!];
  return Array.from({ length: maximum }, (_, index) => (
    unique[Math.round(index * (unique.length - 1) / (maximum - 1))]!
  ));
}

function normalizeTranscriptSummary(
  summary: z.infer<typeof modelTranscriptSummarySchema>,
): GeneratedTranscriptSummary {
  return transcriptSummarySchema.parse({
    ...summary,
    overview: {
      ...summary.overview,
      evidenceIds: selectRepresentativeEvidenceIds(summary.overview.evidenceIds, MAX_SUMMARY_EVIDENCE_IDS),
    },
    sections: summary.sections.map((item) => ({
      ...item,
      evidenceIds: selectRepresentativeEvidenceIds(item.evidenceIds, MAX_SUMMARY_EVIDENCE_IDS),
    })),
  });
}

function compactReadingCheckpoints(checkpoints: readonly string[]): readonly { readonly order: number; readonly notes: string }[] {
  const unique = [...new Set(checkpoints.map((checkpoint) => checkpoint.trim()).filter(Boolean))];
  if (unique.length === 0) throw new Error('The document reader did not produce any viewpoint checkpoints.');
  const charactersPerCheckpoint = Math.max(240, Math.floor(MAX_FINAL_CHECKPOINT_CHARACTERS / unique.length));
  return unique.map((notes, index) => ({
    order: index + 1,
    notes: notes.slice(0, charactersPerCheckpoint),
  }));
}

function finalEvidencePayload(
  prepared: PreparedTranscriptSummary,
  evidenceIds: readonly string[],
  checkpoints: readonly string[],
): string {
  const allowed = new Set(evidenceIds);
  const readingCheckpoints = compactReadingCheckpoints(checkpoints);
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
    const serialized = JSON.stringify({ documentPath: prepared.workingDocumentPath, readingCheckpoints, evidence: candidate });
    if (serialized.length > MAX_FINAL_SYNTHESIS_CHARACTERS) break;
    selected.push(candidate.at(-1)!);
  }
  if (selected.length === 0) throw new Error('The document reader did not retain any usable transcript evidence.');
  return JSON.stringify({ documentPath: prepared.workingDocumentPath, readingCheckpoints, evidence: selected });
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
  outputLanguage: SummaryOutputLanguage,
  context?: AIInvocationContext,
): Promise<{
  readonly notes: string;
  readonly evidenceIds: readonly string[];
  readonly completion: AICompletion;
}> {
  const allowedEvidenceIds = selectRepresentativeEvidenceIds(
    [...previousEvidenceIds, ...window.evidenceIds],
    MAX_READER_EVIDENCE_IDS,
  );
  const task = [
    `Read window ${windowIndex + 1} of ${windowCount} from the transcript working document.`,
    `The document title is: ${prepared.title}. Use it as context for resolving speech-recognition errors.`,
    outputLanguageInstruction(outputLanguage),
    'Update one concise global set of viewpoint-level working notes; integrate new information with earlier notes instead of summarizing this window independently.',
    'Keep the notes as a numbered thematic outline. Preserve earlier distinct themes when later windows introduce unrelated themes; merge only genuine duplicates.',
    'Focus on theses, arguments, supporting reasons, disagreements, changes of position, conclusions, and only the examples needed to understand them.',
    'Do not produce a sentence-by-sentence recap and do not retain one evidence id for every subtitle line.',
    'Never promote a suspicious or garbled transcript token into a named idea. Omit it when the meaning is unclear, or explicitly mark it as transcription-uncertain.',
    `Keep notes under ${MAX_WORKING_NOTES_CHARACTERS} characters.`,
    `Allowed evidenceIds: ${allowedEvidenceIds.join(', ')}.`,
    `Select at most ${MAX_READER_EVIDENCE_IDS} representative evidence anchors for the global viewpoints, ordered by importance. Do not return the complete allowlist.`,
    'Return only JSON. evidenceIds must contain only values from that allowlist.',
    'Never put a sourceId, document path, window id, or working-notes id in evidenceIds.',
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
    responseSchema: readerNotesResponseSchema(allowedEvidenceIds),
  }, context);
  const modelResult = parseStructuredOutput(completion.content, modelReaderNotesSchema);
  for (const id of modelResult.evidenceIds) {
    if (!allowedEvidenceIds.includes(id)) throw new Error(`The document reader cited unknown transcript evidence "${id}".`);
  }
  const result = readerNotesSchema.parse({
    ...modelResult,
    evidenceIds: selectRepresentativeEvidenceIds(modelResult.evidenceIds, MAX_READER_EVIDENCE_IDS),
  });
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
  minimumSections: number,
  context?: AIInvocationContext,
): Promise<{ readonly summary: GeneratedTranscriptSummary; readonly completion: AICompletion }> {
  const allowedIds = [...new Set(allowedEvidenceIds)];
  if (allowedIds.length === 0) throw new Error('At least one transcript evidence id is required for a summary.');
  const boundary = createPromptDataBoundary(task, [{ sourceId, mediaType, content }]);
  const completion = await provider.complete(config, {
    model: config.model,
    messages: boundary.messages,
    temperature: 0.2,
    maxOutputTokens: MAX_OUTPUT_TOKENS_PER_CALL,
    responseFormat: 'json',
    responseSchema: summaryResponseSchema(allowedIds, minimumSections),
  }, context);
  const modelSummary = parseStructuredOutput(completion.content, modelTranscriptSummarySchema);
  validateEvidenceReferences(modelSummary, allowedIds);
  const summary = normalizeTranscriptSummary(modelSummary);
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
  const outputLanguage = detectSummaryOutputLanguage(prepared);
  const task = [
    `Create a ${requestedTemplate} summary in the language primarily used by the transcript.`,
    `The source title is: ${prepared.title}.`,
    outputLanguageInstruction(outputLanguage),
    templateGuidance[requestedTemplate],
    'Synthesize the author\'s viewpoints and reasoning; do not recap sentence by sentence.',
    'Use a plain title and overview understandable without watching the video.',
    'Create distinct thematic sections. Each needs a short heading, an explanatory paragraph, and 2-5 substantive points about definitions, reasons, examples, tensions, or changing positions.',
    'For long documents, preserve every major non-duplicate checkpoint theme in 3-8 sections; never collapse unrelated themes into a generic bullet.',
    'Define important terms inside their relevant section.',
    'End with conclusions or takeaways supported by the speaker; invent nothing.',
    'List only important names or phrases still unclear from context in uncertainties; otherwise use an empty array.',
    'The transcript may contain speech-recognition errors. Use the source title and surrounding argument to resolve only obvious errors. Never repeat a suspicious token as a named idea; omit it or explicitly mark it as transcription-uncertain.',
    'Checkpoints may contain ASR errors. Never copy malformed quotes, names, or terms. Correct only obvious variants; otherwise omit exact wording, paraphrase supported meaning, or list it in uncertainties.',
    'Return only the requested JSON object.',
    `Use only 1-${MAX_SUMMARY_EVIDENCE_IDS} representative evidenceIds for each overview or thematic section as a playback anchor for the whole theme, not as a citation for every sentence or bullet.`,
    'Do not introduce facts that are not supported by the transcript; evidence anchors are representative rather than exhaustive.',
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
      1,
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
  const readingCheckpoints: string[] = [];
  let allEvidenceIds: readonly string[] = [];
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
      outputLanguage,
      context,
    );
    notes = read.notes;
    retainedEvidenceIds = read.evidenceIds;
    readingCheckpoints.push(read.notes);
    allEvidenceIds = [...new Set([...allEvidenceIds, ...read.evidenceIds])];
    completions.push(read.completion);
  }

  const representativeEvidenceIds = selectRepresentativeEvidenceIds(allEvidenceIds, MAX_READER_EVIDENCE_IDS);

  const final = await completeSummary(
    provider,
    config,
    `${task} Use every checkpoint and cover early, middle, and late arguments in 3-8 non-overlapping sections. Each distinct theme must appear or merge only with an equivalent theme. Remove repetition.`,
    `${prepared.workingDocumentPath}#final-synthesis`,
    'application/vnd.oldfolio.document-notes+json',
    finalEvidencePayload(prepared, representativeEvidenceIds, readingCheckpoints),
    representativeEvidenceIds,
    3,
    context,
  );
  completions.push(final.completion);
  const summary = final.summary;
  validateEvidenceReferences(summary, prepared.evidence.map((item) => item.id));
  const completion = aggregateCompletion(completions.at(-1)!, completions);
  return Object.freeze({ summary, completion, template: requestedTemplate, promptVersion: PROMPT_VERSION });
}
