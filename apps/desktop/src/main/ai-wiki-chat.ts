import { createHash } from 'node:crypto';

import {
  createWikiChangeSet,
  estimateTextTokens,
  generateWikiAnswer,
  type WikiQuestionSource,
} from '@oldfolio/ai';
import type { AIInvocationContext, AIProvider, AIProviderConfig, DocumentRevision, WikiChangeSet, WikiCitation } from '@oldfolio/domain';
import { serializeNewOkfConcept } from '@oldfolio/okf';
import {
  extractMarkdownMetadata,
  VaultNotFoundError,
  type AppliedChangeSet,
  type UndoResult,
  type VaultFileSnapshot,
  type VaultRepository,
} from '@oldfolio/vault';

import { DEFAULT_LOCAL_AI_CONTEXT_WINDOW } from './ai-device-config.js';
import type { AIDeviceConfigStore, LocalAIProviderId } from './ai-device-config.js';
import type { AISummaryExecutionTarget, LocalAIProviderResolver } from './ai-summary.js';
import type { OnlineAIService } from './online-ai.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface AIWikiQuestionPreparation {
  readonly id: string;
  readonly question: string;
  readonly executionTarget: AISummaryExecutionTarget;
  readonly endpoint: string;
  readonly model: string;
  readonly providerId: LocalAIProviderId;
  readonly estimatedCost: 0 | null;
  readonly usedTranscriptFallback: boolean;
  readonly sources: readonly {
    readonly path: string;
    readonly title: string;
    readonly kind: 'wiki' | 'transcript';
    readonly revision: string;
    readonly preview: string;
  }[];
}

export interface AIWikiAnswer {
  readonly id: string;
  readonly question: string;
  readonly markdown: string;
  readonly model: string;
  readonly sourcePaths: readonly string[];
  readonly usedTranscriptFallback: boolean;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

export interface AIPendingWikiAnswerSave {
  readonly id: string;
  readonly riskLevel: 'L1' | 'L2';
  readonly targetPath: string;
  readonly content: string;
  readonly diff: string;
}

interface PreparedRecord {
  readonly preparation: AIWikiQuestionPreparation;
  readonly sources: readonly WikiQuestionSource[];
}

interface AnswerRecord {
  readonly answer: AIWikiAnswer;
  readonly promptVersion: string;
  readonly sourceRevisions: Readonly<Record<string, string>>;
  readonly providerId: string;
  readonly model: string;
}

interface PendingRecord {
  readonly changeSet: WikiChangeSet;
  readonly targetPath: string;
  readonly sourcePath: string;
}

function revision(snapshot: VaultFileSnapshot): DocumentRevision {
  return {
    path: snapshot.path,
    revisionId: snapshot.revision,
    contentHash: snapshot.revision,
    modifiedAt: snapshot.modifiedAt.toISOString(),
    byteLength: snapshot.size,
  };
}

function stripFrontmatter(value: string): string {
  return value.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/u, '').trim();
}

function replacementDiff(path: string, previous: string | null, content: string): string {
  const removed = previous === null ? [] : previous.split('\n').map((line) => `-${line}`);
  const added = content.split('\n').map((line) => `+${line}`);
  return [`--- ${previous === null ? '/dev/null' : path}`, `+++ ${path}`, ...removed, ...added].join('\n');
}

function questionSlug(question: string): string {
  const printable = [...question.normalize('NFC')]
    .map((character) => (character.codePointAt(0) ?? 0) < 32 ? '-' : character)
    .join('');
  return printable
    .replaceAll(/[<>:"/\\|?*]/gu, '-')
    .replaceAll(/\s+/gu, '-')
    .replaceAll(/-+/gu, '-')
    .slice(0, 36)
    .replaceAll(/^[.-]+|[. -]+$/gu, '') || '知识库问答';
}

function isTranscript(path: string): boolean {
  return /\/wiki\/transcripts\//u.test(path);
}

function isMaintainedWiki(path: string): boolean {
  return /\/wiki\//u.test(path) && !isTranscript(path) && !/\/wiki\/qa\//u.test(path);
}

function truncateToTokens(content: string, budget: number): string {
  const tokens = estimateTextTokens(content);
  if (tokens <= budget) return content;
  const approximateLength = Math.max(400, Math.floor(content.length * budget / tokens));
  return `${content.slice(0, approximateLength).trimEnd()}\n\n[内容因模型上下文限制已截断]`;
}

function retrievalQueries(question: string): readonly string[] {
  const withoutQuestionWords = question
    .replaceAll(/这个知识库|知识库|请问|哪些|什么|为什么|如何|怎样|怎么|是否|可以|对于|关于|关系|判断|观点|内容|认为|总结|解释/gu, ' ')
    .replaceAll(/[，。！？、；：,.!?;:()（）【】“”‘’]/gu, ' ')
    .replaceAll('[', ' ')
    .replaceAll(']', ' ')
    .replaceAll(/[的了呢吗与和对中是有在从把将]/gu, ' ');
  const keywords = withoutQuestionWords
    .split(/\s+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  return [...new Set([question.trim(), ...keywords])].slice(0, 8);
}

function appendIndexLink(content: string, path: string, title: string): string {
  if (content.includes(`[[${path}`)) return content;
  const line = `- [[${path}|${title}]]`;
  const heading = /^## 问答笔记\s*$/mu;
  if (!heading.test(content)) return `${content.trimEnd()}\n\n## 问答笔记\n\n${line}\n`;
  const match = heading.exec(content);
  const insertAt = (match?.index ?? 0) + (match?.[0].length ?? 0);
  return `${content.slice(0, insertAt)}\n\n${line}${content.slice(insertAt)}`;
}

function prependLog(content: string, date: string, title: string, action: 'create' | 'update'): string {
  const line = `- ${action === 'create' ? '保存' : '更新'}问答：${title}`;
  const dateHeading = `## ${date}`;
  const dateIndex = content.indexOf(dateHeading);
  if (dateIndex >= 0) {
    const insertAt = dateIndex + dateHeading.length;
    return `${content.slice(0, insertAt)}\n\n${line}${content.slice(insertAt)}`;
  }
  const titleMatch = /^#\s+.+$/mu.exec(content);
  const insertAt = titleMatch?.index === undefined ? 0 : titleMatch.index + titleMatch[0].length;
  return `${content.slice(0, insertAt)}\n\n${dateHeading}\n\n${line}\n${content.slice(insertAt).replace(/^\s*/u, '')}`;
}

export class AIWikiChatService {
  private readonly prepared = new Map<string, PreparedRecord>();
  private readonly answers = new Map<string, AnswerRecord>();
  private readonly pending = new Map<string, PendingRecord>();
  private readonly appliedSources = new Map<string, string>();

  constructor(
    private readonly repository: VaultRepository,
    private readonly configStore: AIDeviceConfigStore,
    private readonly providerResolver: LocalAIProviderResolver,
    private readonly now: () => Date = () => new Date(),
    private readonly onlineAI?: OnlineAIService,
  ) {}

  async prepare(question: string, executionTarget: AISummaryExecutionTarget): Promise<AIWikiQuestionPreparation> {
    const normalizedQuestion = question.replaceAll(/\s+/gu, ' ').trim();
    if (!normalizedQuestion || normalizedQuestion.length > 1_000) throw new Error('请输入 1–1,000 个字符的知识库问题。');
    const execution = await this.execution(executionTarget);
    const hitBatches = await Promise.all(retrievalQueries(normalizedQuestion).map((query) => this.repository.search(query, 100)));
    const hits = [...new Map(hitBatches.flat().map((hit) => [hit.path, hit])).values()];
    const wikiHits = hits.filter((hit) => isMaintainedWiki(hit.path)).slice(0, 6);
    const noteHits = hits.filter((hit) => hit.path.startsWith('notes/')).slice(0, Math.max(0, 4 - wikiHits.length));
    const selected = [...wikiHits, ...noteHits];
    const transcriptHits = selected.length < 3
      ? hits.filter((hit) => isTranscript(hit.path)).slice(0, 3 - selected.length)
      : [];
    const selectedHits = [...selected, ...transcriptHits];
    if (selectedHits.length === 0) throw new Error('知识库中没有找到与这个问题相关的内容。请先生成摘要或可复用概念，或换一种问法。');
    const snapshots = await Promise.all(selectedHits.map((hit) => this.repository.read(hit.path)));
    const inputBudget = Math.max(1_500, Math.floor((execution.config.contextWindow ?? DEFAULT_LOCAL_AI_CONTEXT_WINDOW) * 0.62));
    const perSourceBudget = Math.max(500, Math.floor(inputBudget / snapshots.length));
    const sources = snapshots.map((snapshot): WikiQuestionSource => ({
      path: snapshot.path,
      title: extractMarkdownMetadata(snapshot.text).title ?? snapshot.path.split('/').at(-1)?.replace(/\.md$/iu, '') ?? snapshot.path,
      content: truncateToTokens(stripFrontmatter(snapshot.text), perSourceBudget),
      kind: isTranscript(snapshot.path) ? 'transcript' : 'wiki',
    }));
    const id = sha256(JSON.stringify({
      question: normalizedQuestion,
      executionTarget,
      sources: snapshots.map((snapshot) => [snapshot.path, snapshot.revision]),
      model: execution.config.model,
    }));
    const preparation: AIWikiQuestionPreparation = {
      id,
      question: normalizedQuestion,
      executionTarget,
      endpoint: execution.config.endpoint,
      model: execution.config.model,
      providerId: execution.config.providerId as LocalAIProviderId,
      estimatedCost: executionTarget === 'local' ? 0 : null,
      usedTranscriptFallback: transcriptHits.length > 0,
      sources: sources.map((source, index) => ({
        path: source.path,
        title: source.title,
        kind: source.kind,
        revision: snapshots[index]!.revision,
        preview: source.content,
      })),
    };
    this.prepared.set(id, { preparation, sources });
    while (this.prepared.size > 10) this.prepared.delete(this.prepared.keys().next().value as string);
    return preparation;
  }

  async answer(preparationId: string, signal?: AbortSignal): Promise<AIWikiAnswer> {
    const record = this.prepared.get(preparationId);
    if (!record) throw new Error('问答准备记录不存在或已过期，请重新检索。');
    const snapshots = await Promise.all(record.preparation.sources.map((source) => this.repository.read(source.path)));
    for (let index = 0; index < snapshots.length; index += 1) {
      if (snapshots[index]!.revision !== record.preparation.sources[index]!.revision) {
        throw new Error('用于回答的知识页面已发生变化，请重新检索。');
      }
    }
    const execution = await this.execution(record.preparation.executionTarget, signal);
    const generated = await generateWikiAnswer(
      execution.provider,
      execution.config,
      record.preparation.question,
      record.sources,
      execution.context,
    );
    const id = sha256(`${preparationId}:${generated.completion.model}:${generated.markdown}`);
    const answer: AIWikiAnswer = {
      id,
      question: record.preparation.question,
      markdown: generated.markdown,
      model: generated.completion.model,
      sourcePaths: record.sources.map((source) => source.path),
      usedTranscriptFallback: record.preparation.usedTranscriptFallback,
      ...(generated.completion.usage ? { usage: generated.completion.usage } : {}),
    };
    this.answers.set(id, {
      answer,
      promptVersion: generated.promptVersion,
      sourceRevisions: Object.fromEntries(snapshots.map((snapshot) => [snapshot.path, snapshot.revision])),
      providerId: execution.config.providerId,
      model: generated.completion.model,
    });
    this.prepared.delete(preparationId);
    while (this.answers.size > 10) this.answers.delete(this.answers.keys().next().value as string);
    return answer;
  }

  async prepareSave(answerId: string): Promise<AIPendingWikiAnswerSave> {
    const record = this.answers.get(answerId);
    if (!record) throw new Error('问答结果不存在或已过期，请重新提问。');
    const snapshots = await Promise.all(record.answer.sourcePaths.map((path) => this.repository.read(path)));
    for (const snapshot of snapshots) {
      if (record.sourceRevisions[snapshot.path] !== snapshot.revision) throw new Error('问答引用的知识页面已发生变化，请重新提问。');
    }
    const date = this.now().toISOString().slice(0, 10);
    const targetPath = `bundles/personal/wiki/qa/${date}/${questionSlug(record.answer.question)}-${sha256(record.answer.question).slice(0, 12)}.md`;
    const existing = await this.readOptional(targetPath);
    const indexSnapshot = await this.repository.read('bundles/personal/index.md');
    const logSnapshot = await this.repository.read('bundles/personal/log.md');
    const title = record.answer.question.length > 60 ? `${record.answer.question.slice(0, 60)}…` : record.answer.question;
    const content = serializeNewOkfConcept({
      frontmatter: {
        type: 'Synthesis',
        title,
        description: '基于 Oldfolio 本地知识库生成的可审阅问答。',
        sources: snapshots.map((snapshot, index) => ({
          resource: snapshot.path,
          id: `knowledge-${sha256(snapshot.path).slice(0, 24)}`,
          title: extractMarkdownMetadata(snapshot.text).title ?? record.answer.sourcePaths[index],
        })),
        status: 'draft',
        generated: { by: `${record.providerId}:${record.model}`, at: this.now().toISOString() },
        oldfolio: {
          id: `qa-${sha256(record.answer.question).slice(0, 24)}`,
          question: record.answer.question,
          prompt_version: record.promptVersion,
        },
      },
      body: `# ${title}\n\n> 问题：${record.answer.question}\n\n${record.answer.markdown}`,
    });
    const riskLevel = existing ? 'L2' as const : 'L1' as const;
    const citations: WikiCitation[] = snapshots.map((snapshot, index) => {
      const sourceTitle = extractMarkdownMetadata(snapshot.text).title;
      return {
        id: `qa-source-${index + 1}`,
        sourceId: `knowledge-${sha256(snapshot.path).slice(0, 24)}`,
        resource: snapshot.path,
        ...(sourceTitle ? { title: sourceTitle } : {}),
      };
    });
    const operation = existing
      ? { kind: 'update' as const, path: targetPath, baseRevision: revision(existing), content, contentHash: sha256(content) }
      : { kind: 'create' as const, path: targetPath, content, contentHash: sha256(content) };
    const indexContent = appendIndexLink(indexSnapshot.text, targetPath, title);
    const logContent = prependLog(logSnapshot.text, date, title, existing ? 'update' : 'create');
    const answerDiff = replacementDiff(targetPath, existing?.text ?? null, content);
    const changeSet = await createWikiChangeSet({
      baseRevisions: [
        ...snapshots.map(revision),
        revision(indexSnapshot),
        revision(logSnapshot),
        ...(existing ? [revision(existing)] : []),
      ],
      sourceHashes: Object.fromEntries(snapshots.map((snapshot) => [snapshot.path, snapshot.revision])),
      generator: { providerId: record.providerId, model: record.model, promptVersion: record.promptVersion },
      riskLevel,
      items: [
        {
          id: `qa-save-${sha256(targetPath).slice(0, 16)}`,
          summary: existing ? '更新知识库问答' : '保存知识库问答',
          riskLevel,
          operation,
          diff: answerDiff,
          citationIds: citations.map((citation) => citation.id),
        },
        {
          id: `qa-index-${sha256(targetPath).slice(0, 16)}`,
          summary: '更新个人知识目录',
          riskLevel: 'L1',
          operation: {
            kind: 'update', path: indexSnapshot.path, baseRevision: revision(indexSnapshot),
            content: indexContent, contentHash: sha256(indexContent),
          },
          diff: replacementDiff(indexSnapshot.path, indexSnapshot.text, indexContent),
          citationIds: [],
        },
        {
          id: `qa-log-${sha256(targetPath).slice(0, 16)}`,
          summary: '更新知识包变更日志',
          riskLevel: 'L1',
          operation: {
            kind: 'update', path: logSnapshot.path, baseRevision: revision(logSnapshot),
            content: logContent, contentHash: sha256(logContent),
          },
          diff: replacementDiff(logSnapshot.path, logSnapshot.text, logContent),
          citationIds: [],
        },
      ],
      citations,
      createdAt: this.now().toISOString(),
    });
    this.pending.set(changeSet.id, { changeSet, targetPath, sourcePath: snapshots[0]!.path });
    this.answers.delete(answerId);
    return { id: changeSet.id, riskLevel, targetPath, content, diff: changeSet.items.map((item) => item.diff).join('\n\n') };
  }

  async apply(changeSetId: string): Promise<AppliedChangeSet & { readonly targetPath: string }> {
    const pending = this.pending.get(changeSetId);
    if (!pending) throw new Error('问答变更集不存在或已过期，请重新生成。');
    const applied = await this.repository.applyChangeSet(pending.changeSet);
    await this.repository.rebuildIndex();
    this.pending.delete(changeSetId);
    this.appliedSources.set(applied.historyId, pending.sourcePath);
    return { ...applied, targetPath: pending.targetPath };
  }

  async undo(historyId: string): Promise<UndoResult & { readonly sourcePath?: string }> {
    const undone = await this.repository.undo(historyId);
    await this.repository.rebuildIndex();
    const sourcePath = this.appliedSources.get(historyId);
    this.appliedSources.delete(historyId);
    return { ...undone, ...(sourcePath ? { sourcePath } : {}) };
  }

  private async execution(target: AISummaryExecutionTarget, signal?: AbortSignal): Promise<{
    readonly provider: AIProvider;
    readonly config: AIProviderConfig;
    readonly context: AIInvocationContext;
  }> {
    if (target === 'online') {
      if (!this.onlineAI) throw new Error('在线 AI 服务尚未初始化。');
      const runtime = await this.onlineAI.runtime(signal);
      return { provider: runtime.provider, config: runtime.config, context: runtime.context };
    }
    const config = await this.configStore.load();
    if (!config.model) throw new Error('请先连接本地 AI 服务并选择模型。');
    return {
      provider: this.providerResolver(config.providerId),
      config,
      context: { resolveSecret: () => Promise.resolve(undefined), ...(signal ? { signal } : {}) },
    };
  }

  private async readOptional(path: string): Promise<VaultFileSnapshot | null> {
    try {
      return await this.repository.read(path);
    } catch (error: unknown) {
      if (error instanceof VaultNotFoundError) return null;
      throw error;
    }
  }
}
