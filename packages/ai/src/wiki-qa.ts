import type {
  AICompletion,
  AIInvocationContext,
  AIProvider,
  AIProviderConfig,
} from '@oldfolio/domain';

import { createPromptDataBoundary } from './prompt-boundary.js';
import { estimateTextTokens } from './summary.js';

const PROMPT_VERSION = 'wiki-qa-v1-markdown-first';
const DEFAULT_OUTPUT_TOKENS = 3_072;

export interface WikiQuestionSource {
  readonly path: string;
  readonly title: string;
  readonly content: string;
  readonly kind: 'wiki' | 'transcript';
}

export interface GeneratedWikiAnswer {
  readonly markdown: string;
  readonly completion: AICompletion;
  readonly promptVersion: string;
}

function stripEnvelope(value: string): string {
  const trimmed = value
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/u, '')
    .trim();
  const fence = trimmed.match(/^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/iu);
  return (fence?.[1] ?? trimmed).trim();
}

function keepKnownWikiLinks(markdown: string, sources: readonly WikiQuestionSource[]): string {
  const allowed = new Set(sources.map((source) => source.path.normalize('NFC')));
  return markdown.replaceAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/gu, (_match, rawTarget: string, rawLabel?: string) => {
    const target = rawTarget.trim().replaceAll('\\', '/').normalize('NFC');
    const label = rawLabel?.trim() || target;
    return allowed.has(target) ? `[[${target}|${label}]]` : label;
  });
}

function sourceList(sources: readonly WikiQuestionSource[]): string {
  return sources.map((source) => `- [[${source.path}|${source.title}]]`).join('\n');
}

export async function generateWikiAnswer(
  provider: AIProvider,
  config: AIProviderConfig,
  question: string,
  sources: readonly WikiQuestionSource[],
  context?: AIInvocationContext,
): Promise<GeneratedWikiAnswer> {
  const normalizedQuestion = question.replaceAll(/\s+/gu, ' ').trim();
  if (!normalizedQuestion) throw new Error('知识库问题不能为空。');
  if (sources.length === 0) throw new Error('没有找到可用于回答的知识库内容。');
  const task = [
    `回答用户问题：“${normalizedQuestion}”`,
    '优先综合已经维护的 wiki；只有标记为 transcript 的记录才是补充原始转录。',
    '只依据提供的记录回答。知识库证据不足时明确说明缺少什么，不要用常识补写成确定事实。',
    '输出自然、清楚的 Markdown，可使用标题、段落和列表；不要输出 YAML、JSON、代码围栏、内部证据 ID 或时间戳。',
    '引用具体知识时使用记录对应的完整 Wiki 链接，例如 [[bundles/personal/wiki/concepts/example.md|概念名]]。',
    '不要逐句罗列来源，也不要为了引用破坏阅读；优先回答问题，再在关键判断后引用最相关页面。',
  ].join('\n');
  const boundary = createPromptDataBoundary(task, sources.map((source, index) => ({
    sourceId: `knowledge-${String(index + 1).padStart(3, '0')}`,
    mediaType: 'text/markdown',
    content: `PATH: ${source.path}\nTITLE: ${source.title}\nKIND: ${source.kind}\n\n${source.content}`,
  })));
  const contextWindow = config.contextWindow ?? 8_192;
  const outputTokens = Math.min(DEFAULT_OUTPUT_TOKENS, Math.max(1_536, Math.floor(contextWindow * 0.18)));
  const estimatedInput = estimateTextTokens(boundary.messages.map((message) => message.content).join('\n'));
  if (estimatedInput + outputTokens > Math.floor(contextWindow * 0.9)) {
    throw new Error('检索到的知识内容超过当前模型上下文，请缩小问题范围或使用更大上下文模型。');
  }
  const completion = await provider.complete(config, {
    model: config.model,
    messages: boundary.messages,
    temperature: 0.2,
    maxOutputTokens: outputTokens,
    reasoningMode: 'disabled',
    responseFormat: 'text',
  }, context);
  const answer = keepKnownWikiLinks(stripEnvelope(completion.content), sources);
  if (!answer) throw new Error('模型没有返回可用的知识库回答。');
  return {
    markdown: `${answer}\n\n## 参考知识\n\n${sourceList(sources)}`,
    completion,
    promptVersion: PROMPT_VERSION,
  };
}
