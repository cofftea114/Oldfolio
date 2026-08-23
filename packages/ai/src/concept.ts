import type {
  AICompletion,
  AIInvocationContext,
  AIProvider,
  AIProviderConfig,
} from '@oldfolio/domain';

import { createPromptDataBoundary } from './prompt-boundary.js';
import { estimateTextTokens } from './summary.js';

const PROMPT_VERSION = 'summary-concepts-v1-markdown-first';
const REQUIRED_SECTIONS = ['摘要', '实体', '概念', '对比', '概述与综合'] as const;
const DEFAULT_OUTPUT_TOKENS = 4_096;
const MAX_CONCEPTS = 8;

export interface ExistingConceptSummary {
  readonly title: string;
  readonly path: string;
  readonly excerpt?: string;
}

export interface ExtractedConcept {
  readonly title: string;
  readonly markdown: string;
}

export interface GenerateConceptsInput {
  readonly sourcePath: string;
  readonly sourceTitle: string;
  readonly sourceMarkdown: string;
  readonly existingConcepts: readonly ExistingConceptSummary[];
}

export interface GenerateConceptsResult {
  readonly concepts: readonly ExtractedConcept[];
  readonly completion: AICompletion;
  readonly promptVersion: string;
}

function stripFrontmatter(value: string): string {
  return value.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/u, '').trim();
}

function stripFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/iu);
  return (match?.[1] ?? trimmed).trim();
}

function cleanTitle(value: string): string {
  return value
    .replaceAll('*', '')
    .replaceAll('_', '')
    .replaceAll('`', '')
    .replaceAll('#', '')
    .replaceAll('[', '')
    .replaceAll(']', '')
    .replaceAll(/^[\s\d.、:：-]+|\s+$/gu, '')
    .replaceAll(/\s+/gu, ' ')
    .slice(0, 48)
    .trim();
}

function sectionMap(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  const matches = [...markdown.matchAll(/^###\s+(.+?)\s*$\r?\n?/gmu)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (match?.index === undefined) continue;
    const name = cleanTitle(match[1] ?? '');
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    const content = markdown.slice(start, end).trim();
    if (name && content && !sections.has(name)) sections.set(name, content);
  }
  return sections;
}

function normalizeConceptBody(title: string, rawBody: string): string {
  const sections = sectionMap(rawBody);
  const unsectioned = rawBody
    .replace(/^#.*$/gmu, '')
    .replace(/^###\s+.+?$[\s\S]*?(?=^###\s+|\s*$)/gmu, '')
    .trim();
  return [
    `# ${title}`,
    '',
    ...REQUIRED_SECTIONS.flatMap((section, index) => {
      const content = sections.get(section)
        ?? (index === 0 && unsectioned ? unsectioned : '暂无可确认内容。');
      return [`## ${section}`, '', content, ''];
    }),
  ].join('\n').trimEnd();
}

/**
 * Parses model-authored Markdown without requiring JSON, a fixed item count, or
 * exact schema compliance. Missing sections are repaired locally so formatting
 * variance cannot discard an otherwise useful concept.
 */
export function parseConceptMarkdown(value: string): readonly ExtractedConcept[] {
  const markdown = stripFence(stripFrontmatter(value));
  const headings = [...markdown.matchAll(/^##\s+(?!#)(.+?)\s*$\r?\n?/gmu)];
  const parsed: ExtractedConcept[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < headings.length && parsed.length < MAX_CONCEPTS; index += 1) {
    const heading = headings[index];
    if (heading?.index === undefined) continue;
    const title = cleanTitle(heading[1] ?? '');
    const normalized = title.normalize('NFC').toLocaleLowerCase('zh-CN');
    if (!title || REQUIRED_SECTIONS.includes(title as typeof REQUIRED_SECTIONS[number]) || seen.has(normalized)) continue;
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? markdown.length;
    parsed.push({ title, markdown: normalizeConceptBody(title, markdown.slice(start, end)) });
    seen.add(normalized);
  }

  if (parsed.length > 0) return parsed;
  const h1 = cleanTitle(markdown.match(/^#\s+(.+?)\s*$/mu)?.[1] ?? '');
  if (!h1 || !markdown.trim()) throw new Error('模型没有返回可用的概念内容。');
  return [{ title: h1, markdown: normalizeConceptBody(h1, markdown) }];
}

function existingCatalog(items: readonly ExistingConceptSummary[]): string {
  if (items.length === 0) return '（当前没有已有概念页）';
  return items.slice(0, 200).map((item) => (
    `- ${item.title} | ${item.path}${item.excerpt ? ` | ${item.excerpt.replaceAll(/\s+/gu, ' ').slice(0, 160)}` : ''}`
  )).join('\n');
}

export async function generateConceptsFromSummary(
  provider: AIProvider,
  config: AIProviderConfig,
  input: GenerateConceptsInput,
  context?: AIInvocationContext,
): Promise<GenerateConceptsResult> {
  const task = [
    '从一篇已经整理好的摘要笔记中提炼少量真正可复用的知识概念。',
    '质量优先，不要求固定数量；如果没有值得独立维护的概念，可以只输出一个。最多输出 8 个。',
    '概念标题必须是主题名，而不是视频名、作者名、摘要名或“某某的观点”；中文标题通常控制在 4–12 个汉字。',
    '不要逐句复述摘要。概念页应能脱离当前来源独立阅读，并明确其含义、相关实体、适用边界、对比关系和综合认识。',
    '已有概念目录中若存在同义主题，必须原样复用其标题，不要创建近义重复页。',
    '只输出 Markdown，不输出 YAML、JSON、代码围栏、证据 ID 或时间戳。',
    '输出格式：先写“# 概念候选”，每个概念以“## 概念标题”开始，并依次包含“### 摘要”“### 实体”“### 概念”“### 对比”“### 概述与综合”。',
    `在“实体”中加入可点击来源链接 [[${input.sourcePath}|${input.sourceTitle}]]；不要捏造其他来源。`,
    '',
    '已有概念目录：',
    existingCatalog(input.existingConcepts),
  ].join('\n');
  const boundary = createPromptDataBoundary(task, [{
    sourceId: 'summary-note',
    mediaType: 'text/markdown',
    content: stripFrontmatter(input.sourceMarkdown).slice(0, 300_000),
  }]);
  const contextWindow = config.contextWindow ?? 8_192;
  const estimatedInput = estimateTextTokens(boundary.messages.map((message) => message.content).join('\n'));
  if (estimatedInput + DEFAULT_OUTPUT_TOKENS > Math.floor(contextWindow * 0.9)) {
    throw new Error(`当前摘要约需 ${estimatedInput.toLocaleString()} 输入 tokens，超过模型可用于概念提取的上下文。请使用更大上下文模型或先缩短摘要。`);
  }
  const completion = await provider.complete(config, {
    model: config.model,
    messages: boundary.messages,
    temperature: 0.25,
    maxOutputTokens: Math.min(DEFAULT_OUTPUT_TOKENS, Math.max(1_536, Math.floor(contextWindow * 0.2))),
    reasoningMode: 'disabled',
    responseFormat: 'text',
  }, context);
  return {
    concepts: parseConceptMarkdown(completion.content),
    completion,
    promptVersion: PROMPT_VERSION,
  };
}
