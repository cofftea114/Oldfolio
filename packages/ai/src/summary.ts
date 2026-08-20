import type {
  AICompletion,
  AIInvocationContext,
  AIProvider,
  AIProviderConfig,
} from '@oldfolio/domain';

import { createPromptDataBoundary } from './prompt-boundary.js';
import {
  SUMMARY_TEMPLATES,
  classifySummaryTemplate,
  type SummaryTemplate,
} from './templates.js';

const MAX_SOURCE_CHARACTERS = 200_000;
const MAX_SEGMENT_PART_CHARACTERS = 2_500;
const MAX_WORKING_NOTES_CHARACTERS = 1_400;
const MAX_FINAL_CHECKPOINT_CHARACTERS = 4_000;
const MAX_FINAL_SYNTHESIS_CHARACTERS = 6_500;
const MAX_READER_OUTPUT_TOKENS = 1_280;
const DEFAULT_SUMMARY_OUTPUT_TOKENS = 2_560;
const MAX_SUMMARY_OUTPUT_TOKENS = 8_192;
const DEEP_ANALYSIS_OUTPUT_TOKENS = 32_768;
const DEEP_MIN_CONTEXT_WINDOW_TOKENS = 65_536;
const DEEP_ANALYSIS_PROMPT_RESERVE_TOKENS = 1_536;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 8_192;
const MIN_CONTEXT_WINDOW_TOKENS = 8_192;
const MAX_CONTEXT_WINDOW_TOKENS = 10_000_000;
const CONTEXT_SAFETY_RATIO = 0.85;
const DIRECT_PROMPT_RESERVE_TOKENS = 1_536;
const READER_PROMPT_RESERVE_TOKENS = 1_536;
const MIN_DOCUMENT_WINDOW_TOKENS = 512;
const PROMPT_VERSION = 'transcript-summary-v10-markdown-first';

export type TranscriptSummaryMode = 'fast' | 'deep';

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
  readonly mode?: TranscriptSummaryMode;
  /** Effective model context window, including input and output tokens. */
  readonly contextWindow?: number;
  /** Tokens reserved for the final structured summary response. */
  readonly reservedOutputTokens?: number;
}

export interface SummaryEvidence {
  readonly id: string;
  readonly startMs: number;
  readonly endMs?: number;
  readonly text: string;
  readonly speaker?: string;
}

export interface GeneratedTranscriptSummary {
  /** A short note title, extracted from the model's first H1 when present. */
  readonly title: string;
  /** Human-readable Markdown. This is the primary model output, not a JSON projection. */
  readonly markdown: string;
}

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
  readonly mode: TranscriptSummaryMode;
  readonly contextWindow: number;
  readonly reservedOutputTokens: number;
  readonly analysisOutputTokens: number;
  readonly inputTokenBudget: number;
  readonly windowTokenBudget: number;
  readonly processingMode: 'direct' | 'document-reader';
  readonly estimatedModelCalls: number;
}

export interface GenerateTranscriptSummaryResult {
  readonly summary: GeneratedTranscriptSummary;
  readonly completion: AICompletion;
  readonly template: SummaryTemplate;
  readonly promptVersion: string;
  readonly mode: TranscriptSummaryMode;
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
}

interface SummaryContextBudget {
  readonly contextWindow: number;
  readonly reservedOutputTokens: number;
  readonly analysisOutputTokens: number;
  readonly usableContextTokens: number;
  readonly directInputTokenBudget: number;
  readonly windowTokenBudget: number;
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
    return 'Every generated text field must use Simplified Chinese, including working notes, title, overview, section headings, points, takeaways, and uncertainties. Never answer in English.';
  }
  return 'Every generated text field must use English, including working notes, title, overview, section headings, points, takeaways, and uncertainties.';
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

/**
 * Provider-neutral, deliberately conservative token estimate. CJK scripts are
 * commonly close to one token per code point, while Latin text and JSON average
 * several code points per token. Exact billing remains provider-specific.
 */
export function estimateTextTokens(value: string): number {
  if (!value) return 0;
  let cjk = 0;
  let other = 0;
  for (const character of value) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(cjk + other / 3));
}

function normalizeTokenCount(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new Error(`${label} must be a positive integer.`);
  return normalized;
}

function createSummaryContextBudget(
  contextWindowValue: number | undefined,
  reservedOutputValue: number | undefined,
  mode: TranscriptSummaryMode,
): SummaryContextBudget {
  const contextWindow = normalizeTokenCount(contextWindowValue, DEFAULT_CONTEXT_WINDOW_TOKENS, 'Model context window');
  if (contextWindow < MIN_CONTEXT_WINDOW_TOKENS || contextWindow > MAX_CONTEXT_WINDOW_TOKENS) {
    throw new Error(`Model context window must be between ${MIN_CONTEXT_WINDOW_TOKENS.toLocaleString()} and ${MAX_CONTEXT_WINDOW_TOKENS.toLocaleString()} tokens.`);
  }
  if (mode === 'deep' && contextWindow < DEEP_MIN_CONTEXT_WINDOW_TOKENS) {
    throw new Error(`Deep summary mode requires a context window of at least ${DEEP_MIN_CONTEXT_WINDOW_TOKENS.toLocaleString()} tokens.`);
  }
  const adaptiveOutputTokens = Math.min(
    MAX_SUMMARY_OUTPUT_TOKENS,
    Math.max(DEFAULT_SUMMARY_OUTPUT_TOKENS, Math.floor(contextWindow * 0.1)),
  );
  const reservedOutputTokens = normalizeTokenCount(
    reservedOutputValue,
    mode === 'deep' ? MAX_SUMMARY_OUTPUT_TOKENS : adaptiveOutputTokens,
    'Summary output reserve',
  );
  const usableContextTokens = Math.floor(contextWindow * CONTEXT_SAFETY_RATIO);
  const analysisOutputTokens = mode === 'deep'
    ? Math.min(DEEP_ANALYSIS_OUTPUT_TOKENS, Math.floor(usableContextTokens / 2))
    : 0;
  const directInputTokenBudget = Math.max(0, usableContextTokens
    - (mode === 'deep' ? analysisOutputTokens : reservedOutputTokens)
    - (mode === 'deep' ? DEEP_ANALYSIS_PROMPT_RESERVE_TOKENS : DIRECT_PROMPT_RESERVE_TOKENS));
  const workingNotesReserve = estimateTextTokens('x'.repeat(MAX_WORKING_NOTES_CHARACTERS));
  const windowTokenBudget = usableContextTokens
    - MAX_READER_OUTPUT_TOKENS
    - READER_PROMPT_RESERVE_TOKENS
    - workingNotesReserve;
  if (reservedOutputTokens > usableContextTokens - DIRECT_PROMPT_RESERVE_TOKENS - MIN_DOCUMENT_WINDOW_TOKENS) {
    throw new Error('The summary output reserve is too large for the selected model context window.');
  }
  if (windowTokenBudget < MIN_DOCUMENT_WINDOW_TOKENS) {
    throw new Error('The selected context window leaves too little room for summary prompts and output.');
  }
  return {
    contextWindow,
    reservedOutputTokens,
    analysisOutputTokens,
    usableContextTokens,
    directInputTokenBudget,
    windowTokenBudget,
  };
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

function splitPromptPartToTokenBudget(part: PromptEvidence, maximumTokens: number): readonly PromptEvidence[] {
  if (estimateTextTokens(evidenceLine(part)) <= maximumTokens) return [part];
  const characters = [...part.text];
  const chunks: PromptEvidence[] = [];
  let offset = 0;
  while (offset < characters.length) {
    let low = offset + 1;
    let high = characters.length;
    let accepted = offset;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate: PromptEvidence = { ...part, text: characters.slice(offset, middle).join(''), part: chunks.length + 1 };
      if (estimateTextTokens(evidenceLine(candidate)) <= maximumTokens) {
        accepted = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (accepted === offset) throw new Error('The model context window is too small for one transcript evidence label.');
    chunks.push({ ...part, text: characters.slice(offset, accepted).join(''), part: chunks.length + 1 });
    offset = accepted;
  }
  return chunks;
}

function buildDocumentWindows(
  evidence: readonly SummaryEvidence[],
  maximumTokens: number,
): readonly DocumentWindow[] {
  const parts = splitEvidenceForPrompt(evidence).flatMap((part) => splitPromptPartToTokenBudget(part, maximumTokens));
  const windows: DocumentWindow[] = [];
  let currentLines: string[] = [];
  let currentTokens = 0;

  const pushCurrent = (): void => {
    if (currentLines.length === 0) return;
    windows.push({ content: currentLines.join('\n') });
    currentLines = [];
    currentTokens = 0;
  };

  for (const part of parts) {
    const line = evidenceLine(part);
    const lineTokens = estimateTextTokens(`${currentLines.length > 0 ? '\n' : ''}${line}`);
    if (currentLines.length > 0 && currentTokens + lineTokens > maximumTokens) pushCurrent();
    currentLines.push(line);
    currentTokens += estimateTextTokens(`${currentLines.length > 1 ? '\n' : ''}${line}`);
  }
  pushCurrent();
  return windows;
}

export function prepareTranscriptSummary(input: PrepareTranscriptSummaryInput): PreparedTranscriptSummary {
  if (!input.sourcePath.trim() || !input.sourceRevision.trim()) throw new Error('A source path and revision are required.');
  if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(input.sourceRevision)) throw new Error('The source revision is not safe for a working-document id.');
  if (!input.resource.trim()) throw new Error('A transcript media resource is required.');
  if (input.segments.length === 0) throw new Error('A transcript requires at least one evidence segment.');
  const mode = input.mode ?? 'fast';

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
  const estimatedInputTokens = estimateTextTokens(workingDocumentContent);
  const budget = createSummaryContextBudget(
    input.contextWindow,
    input.reservedOutputTokens,
    mode,
  );
  const processingMode = estimatedInputTokens <= budget.directInputTokenBudget ? 'direct' : 'document-reader';
  const windows = processingMode === 'direct' ? [] : buildDocumentWindows(evidence, budget.windowTokenBudget);
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
    estimatedInputTokens,
    mode,
    contextWindow: budget.contextWindow,
    reservedOutputTokens: budget.reservedOutputTokens,
    analysisOutputTokens: budget.analysisOutputTokens,
    inputTokenBudget: budget.directInputTokenBudget,
    windowTokenBudget: budget.windowTokenBudget,
    processingMode,
    estimatedModelCalls: processingMode === 'direct'
      ? mode === 'deep' ? 2 : 1
      : windows.length + (mode === 'deep' ? 2 : 1),
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

function finalCheckpointPayload(checkpoints: readonly string[]): string {
  const compact = compactReadingCheckpoints(checkpoints);
  return compact
    .map((checkpoint) => `## 阅读检查点 ${checkpoint.order}\n\n${checkpoint.notes}`)
    .join('\n\n')
    .slice(0, MAX_FINAL_SYNTHESIS_CHARACTERS);
}

function readerWindowContent(content: string): string {
  return content.replace(/^\[segment-\d{5}\s+(.+?)\]/gmu, '[$1]');
}

function stripOuterMarkdownFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/iu);
  return (match?.[1] ?? trimmed).trim();
}

function normalizeGeneratedMarkdown(content: string, fallbackTitle: string): GeneratedTranscriptSummary {
  let markdown = stripOuterMarkdownFence(content)
    .replace(/<think>[\s\S]*?<\/think>/giu, '')
    .trim();
  if (markdown.startsWith('---\n')) {
    const closing = markdown.indexOf('\n---\n', 4);
    if (closing >= 0) markdown = markdown.slice(closing + 5).trim();
  }
  // Segment labels are an internal reading aid. They must never make the user-facing
  // note noisy or turn a good summary into a validation failure.
  markdown = markdown
    .replace(/\s*\[segment-\d{5}\]/gu, '')
    .replace(/\bsegment-\d{5}\b/gu, '')
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (!markdown) throw new Error('AI 模型没有返回可用的摘要正文。');
  const heading = markdown.match(/^#\s+(.+)$/mu);
  const title = (heading?.[1] ?? fallbackTitle).trim().slice(0, 200) || 'AI 摘要';
  if (heading?.[0]) markdown = markdown.replace(heading[0], '').trim();
  if (!markdown) throw new Error('AI 模型只返回了标题，没有返回摘要正文。');
  return Object.freeze({ title, markdown });
}

async function readDocumentWindow(
  provider: AIProvider,
  config: AIProviderConfig,
  prepared: PreparedTranscriptSummary,
  window: DocumentWindow,
  windowIndex: number,
  windowCount: number,
  previousNotes: string,
  outputLanguage: SummaryOutputLanguage,
  context?: AIInvocationContext,
): Promise<{
  readonly notes: string;
  readonly completion: AICompletion;
}> {
  const task = [
    `Read window ${windowIndex + 1} of ${windowCount} from the transcript working document.`,
    `The document title is: ${prepared.title}. Use it as context for resolving speech-recognition errors.`,
    outputLanguageInstruction(outputLanguage),
    'Update one concise global set of viewpoint-level working notes; integrate new information with earlier notes instead of summarizing this window independently.',
    'Keep the notes as a numbered thematic outline. Preserve earlier distinct themes when later windows introduce unrelated themes; merge only genuine duplicates.',
    'Focus on theses, arguments, supporting reasons, disagreements, changes of position, conclusions, and only the examples needed to understand them.',
    'Do not produce a sentence-by-sentence recap.',
    'Never promote a suspicious or garbled transcript token into a named idea. Omit it when the meaning is unclear, or explicitly mark it as transcription-uncertain.',
    `Keep notes under ${MAX_WORKING_NOTES_CHARACTERS} characters.`,
    'Return only concise Markdown working notes. Do not return JSON, evidence IDs, timestamps, or source paths.',
  ].join(' ');
  const boundary = createPromptDataBoundary(task, [
    {
      sourceId: `${prepared.workingDocumentPath}#window-${windowIndex + 1}`,
      mediaType: 'text/plain',
      content: readerWindowContent(window.content),
    },
    {
      sourceId: `${prepared.workingDocumentPath}#working-notes`,
      mediaType: 'text/markdown',
      content: previousNotes,
    },
  ]);
  const completion = await provider.complete(config, {
    model: config.model,
    messages: boundary.messages,
    temperature: 0.1,
    maxOutputTokens: MAX_READER_OUTPUT_TOKENS,
    reasoningMode: 'disabled',
    responseFormat: 'text',
  }, context);
  const notes = stripOuterMarkdownFence(completion.content).trim().slice(0, MAX_WORKING_NOTES_CHARACTERS);
  if (!notes) throw new Error('AI 模型没有返回可用的阅读笔记。');
  return { notes, completion };
}

async function completeMarkdownSummary(
  provider: AIProvider,
  config: AIProviderConfig,
  task: string,
  sourceId: string,
  mediaType: string,
  content: string,
  fallbackTitle: string,
  maxOutputTokens: number,
  context?: AIInvocationContext,
): Promise<{ readonly summary: GeneratedTranscriptSummary; readonly completion: AICompletion }> {
  const boundary = createPromptDataBoundary(task, [{ sourceId, mediaType, content }]);
  const completion = await provider.complete(config, {
    model: config.model,
    messages: boundary.messages,
    temperature: 0.2,
    maxOutputTokens,
    reasoningMode: 'disabled',
    responseFormat: 'text',
  }, context);
  const summary = normalizeGeneratedMarkdown(completion.content, fallbackTitle);
  return { summary, completion };
}

async function completeDeepAnalysis(
  provider: AIProvider,
  config: AIProviderConfig,
  prepared: PreparedTranscriptSummary,
  requestedTemplate: SummaryTemplate,
  sourceId: string,
  mediaType: string,
  content: string,
  outputLanguage: SummaryOutputLanguage,
  context?: AIInvocationContext,
): Promise<AICompletion> {
  const task = [
    `Read the supplied transcript as a whole and write a deep natural-language ${requestedTemplate} analysis.`,
    `The source title is: ${prepared.title}.`,
    outputLanguageInstruction(outputLanguage),
    templateGuidance[requestedTemplate],
    'This is the reasoning and synthesis stage. Do not return JSON and do not spend effort on Oldfolio field formatting.',
    'Identify the author\'s central thesis, major supporting arguments, definitions, causal links, examples, tensions, changes of position, and conclusions.',
    'Prioritize interpretation of the author\'s viewpoints over sentence-by-sentence recap. Preserve distinct themes and explain how they relate.',
    'Resolve only obvious speech-recognition errors from title and context. Mark important unresolved terms as uncertain instead of inventing meanings.',
    'Do not include evidence IDs, timestamps, source paths, JSON, or YAML frontmatter.',
    'Write readable Markdown prose with headings. Return only the analysis body.',
  ].join(' ');
  const boundary = createPromptDataBoundary(task, [{ sourceId, mediaType, content }]);
  return provider.complete(config, {
    model: config.model,
    messages: boundary.messages,
    temperature: 0.2,
    maxOutputTokens: prepared.analysisOutputTokens,
    reasoningMode: 'enabled',
    responseFormat: 'text',
  }, context);
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
    'Write for a reader who has not watched the video: state the central thesis early, explain the reasoning clearly, and retain only examples that help understanding.',
    'Choose the structure and number of sections that best fit the content. Do not fill a fixed template mechanically.',
    'Define important terms inside their relevant section.',
    'End with conclusions or useful implications supported by the speaker; invent nothing.',
    'The transcript may contain speech-recognition errors. Use the source title and surrounding argument to resolve only obvious errors. Never repeat a suspicious token as a named idea; omit it or explicitly mark it as transcription-uncertain.',
    'Checkpoints may contain ASR errors. Never copy malformed quotes, names, or terms. Correct only obvious variants; otherwise omit exact wording, paraphrase supported meaning, or list it in uncertainties.',
    'Return readable Markdown, beginning with one # title. Use paragraphs and lists naturally.',
    'Do not return JSON, YAML frontmatter, evidence IDs, timestamps, source paths, or per-sentence citations.',
  ].join(' ');
  const windows = prepared.processingMode === 'direct'
    ? []
    : buildDocumentWindows(prepared.evidence, prepared.windowTokenBudget);
  const completions: AICompletion[] = [];
  if (prepared.processingMode === 'direct' && prepared.mode === 'fast') {
    const result = await completeMarkdownSummary(
      provider,
      config,
      task,
      prepared.workingDocumentPath,
      'text/plain',
      prepared.workingDocumentContent,
      prepared.title,
      prepared.reservedOutputTokens,
      context,
    );
    return Object.freeze({
      summary: result.summary,
      completion: result.completion,
      template: requestedTemplate,
      promptVersion: PROMPT_VERSION,
      mode: prepared.mode,
    });
  }

  if (prepared.processingMode === 'direct' && prepared.mode === 'deep') {
    const analysis = await completeDeepAnalysis(
      provider,
      config,
      prepared,
      requestedTemplate,
      prepared.workingDocumentPath,
      'text/plain',
      prepared.workingDocumentContent,
      outputLanguage,
      context,
    );
    completions.push(analysis);
    const formatted = await completeMarkdownSummary(
      provider,
      config,
      `${task} The supplied analysis is authoritative. Edit it into a polished note: improve clarity, remove repetition, and preserve its substantive reasoning. Do not redo the analysis and do not force a fixed section count.`,
      `${prepared.workingDocumentPath}#deep-analysis`,
      'text/markdown',
      analysis.content,
      prepared.title,
      prepared.reservedOutputTokens,
      context,
    );
    completions.push(formatted.completion);
    return Object.freeze({
      summary: formatted.summary,
      completion: aggregateCompletion(formatted.completion, completions),
      template: requestedTemplate,
      promptVersion: PROMPT_VERSION,
      mode: prepared.mode,
    });
  }

  let notes = '';
  const readingCheckpoints: string[] = [];
  for (const [index, window] of windows.entries()) {
    const read = await readDocumentWindow(
      provider,
      config,
      prepared,
      window,
      index,
      windows.length,
      notes,
      outputLanguage,
      context,
    );
    notes = read.notes;
    readingCheckpoints.push(read.notes);
    completions.push(read.completion);
  }

  if (prepared.mode === 'deep') {
    const analysis = await completeDeepAnalysis(
      provider,
      config,
      prepared,
      requestedTemplate,
      `${prepared.workingDocumentPath}#reading-checkpoints`,
      'text/markdown',
      finalCheckpointPayload(readingCheckpoints),
      outputLanguage,
      context,
    );
    completions.push(analysis);
    const formatted = await completeMarkdownSummary(
      provider,
      config,
      `${task} The supplied analysis is authoritative. Edit it into a polished note: improve clarity, remove repetition, and preserve its substantive reasoning. Do not redo the analysis and do not force a fixed section count.`,
      `${prepared.workingDocumentPath}#deep-analysis`,
      'text/markdown',
      analysis.content,
      prepared.title,
      prepared.reservedOutputTokens,
      context,
    );
    completions.push(formatted.completion);
    return Object.freeze({
      summary: formatted.summary,
      completion: aggregateCompletion(formatted.completion, completions),
      template: requestedTemplate,
      promptVersion: PROMPT_VERSION,
      mode: prepared.mode,
    });
  }

  const final = await completeMarkdownSummary(
    provider,
    config,
    `${task} Use every reading checkpoint. Preserve distinct themes, merge only genuine duplicates, and remove repetition.`,
    `${prepared.workingDocumentPath}#final-synthesis`,
    'text/markdown',
    finalCheckpointPayload(readingCheckpoints),
    prepared.title,
    prepared.reservedOutputTokens,
    context,
  );
  completions.push(final.completion);
  const completion = aggregateCompletion(completions.at(-1)!, completions);
  return Object.freeze({
    summary: final.summary,
    completion,
    template: requestedTemplate,
    promptVersion: PROMPT_VERSION,
    mode: prepared.mode,
  });
}
