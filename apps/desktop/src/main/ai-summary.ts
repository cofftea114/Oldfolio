import { createHash } from 'node:crypto';
import { parse } from 'node:path';

import {
  AIProviderError,
  OllamaProvider,
  LMStudioProvider,
  SUMMARY_TEMPLATES,
  createWikiChangeSet,
  generateConceptsFromSummary,
  generateTranscriptSummary,
  prepareTranscriptSummary,
  type PreparedTranscriptSummary,
  type SummaryTemplate,
  type TranscriptSummaryLanguage,
  type TranscriptSummaryMode,
} from '@oldfolio/ai';
import type {
  AIInvocationContext,
  AIProvider,
  AIProviderConfig,
  DocumentRevision,
  WikiChangeSet,
  WikiCitation,
} from '@oldfolio/domain';
import { parseTranscriptPlaybackManifest } from '@oldfolio/media';
import { parseOkfDocument, serializeNewOkfConcept, type ParsedOkfConcept } from '@oldfolio/okf';
import {
  VaultNotFoundError,
  type AppliedChangeSet,
  type UndoResult,
  type VaultFileSnapshot,
  type VaultRepository,
} from '@oldfolio/vault';

import { DEFAULT_LOCAL_AI_CONTEXT_WINDOW, normalizeAIContextWindow, normalizeLocalAIEndpoint } from './ai-device-config.js';
import type { AIDeviceConfigStore, LocalAIProviderId } from './ai-device-config.js';
import type { OnlineAIService } from './online-ai.js';

export type AISummaryExecutionTarget = 'local' | 'online';

export interface AISummaryPreparation {
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly suggestedTemplate: SummaryTemplate;
  readonly templateConfidence: number;
  readonly availableTemplates: readonly SummaryTemplate[];
  readonly segmentCount: number;
  readonly sourceCharacters: number;
  readonly estimatedInputTokens: number;
  readonly mode: TranscriptSummaryMode;
  readonly requestedOutputLanguage: TranscriptSummaryLanguage;
  readonly outputLanguage: Exclude<TranscriptSummaryLanguage, 'auto'>;
  readonly contextWindow: number;
  readonly reservedOutputTokens: number;
  readonly analysisOutputTokens: number;
  readonly inputTokenBudget: number;
  readonly windowTokenBudget: number;
  readonly workingDocumentPath: string;
  readonly processingMode: 'direct' | 'document-reader';
  readonly estimatedModelCalls: number;
  readonly endpoint: string;
  readonly model: string;
  readonly providerId: LocalAIProviderId;
  readonly executionTarget: AISummaryExecutionTarget;
  readonly dataDestination: 'local_ollama' | 'local_lm_studio' | 'online_openai_compatible';
  readonly estimatedCost: 0 | null;
  readonly sourcePreview: string;
}

export interface AIPendingSummaryChange {
  readonly id: string;
  readonly riskLevel: 'L1' | 'L2';
  readonly targetPath: string;
  readonly sourcePath: string;
  readonly template: SummaryTemplate;
  readonly outputLanguage: Exclude<TranscriptSummaryLanguage, 'auto'>;
  readonly contextWindow: number;
  readonly contextWindowAdjusted: boolean;
  readonly content: string;
  readonly diff: string;
  readonly citations: readonly WikiCitation[];
  readonly model: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

export interface AIConceptPreparation {
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly sourceTitle: string;
  readonly existingConceptCount: number;
  readonly sourceCharacters: number;
  readonly endpoint: string;
  readonly model: string;
  readonly providerId: LocalAIProviderId;
  readonly executionTarget: AISummaryExecutionTarget;
  readonly dataDestination: AISummaryPreparation['dataDestination'];
  readonly estimatedCost: 0 | null;
  readonly sourcePreview: string;
}

export interface AIPendingConceptChange {
  readonly id: string;
  readonly riskLevel: 'L1' | 'L2';
  readonly targetPath: string;
  readonly sourcePath: string;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly conceptTitles: readonly string[];
  readonly files: readonly { readonly path: string; readonly action: 'create' | 'update'; readonly content: string }[];
  readonly diff: string;
  readonly model: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

interface PendingRecord {
  readonly changeSet: WikiChangeSet;
  readonly targetPath: string;
  readonly sourcePath: string;
}

export type LocalAIProviderResolver = (providerId: LocalAIProviderId) => AIProvider;

function defaultProvider(providerId: LocalAIProviderId): AIProvider {
  return providerId === 'ollama'
    ? new OllamaProvider()
    : new LMStudioProvider();
}

export function createLocalAIProviderResolver(fetchImplementation: typeof fetch): LocalAIProviderResolver {
  return (providerId) => providerId === 'ollama'
    ? new OllamaProvider({ fetch: fetchImplementation })
    : new LMStudioProvider({ fetch: fetchImplementation });
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const summaryTemplateLabels: Readonly<Record<SummaryTemplate, string>> = {
  course: '课程',
  interview: '访谈',
  podcast: '播客',
  tutorial: '教程',
  meeting: '会议',
  'news-commentary': '观点 / 时事评论',
  debate: '辩论',
  review: '评测',
};

function revision(snapshot: VaultFileSnapshot): DocumentRevision {
  return {
    path: snapshot.path,
    revisionId: snapshot.revision,
    contentHash: snapshot.revision,
    modifiedAt: snapshot.modifiedAt.toISOString(),
    byteLength: snapshot.size,
  };
}

function markdownText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

function knowledgeBundleRoot(path: string): string {
  const root = /^(bundles\/(?:personal|creators\/creator-[a-f0-9]{16}))\/wiki\//u.exec(path)?.[1];
  if (!root) throw new Error('当前文档不属于可维护的个人或博主知识包。');
  return root;
}

function summaryPath(sourcePath: string, language: TranscriptSummaryLanguage): string {
  const stem = parse(sourcePath).name.normalize('NFC').replaceAll(/[^a-zA-Z0-9._-]/gu, '-').replaceAll(/-+/gu, '-').slice(0, 52) || 'transcript';
  const languageSuffix = language === 'auto' ? '' : `-${language.toLowerCase()}`;
  return `${knowledgeBundleRoot(sourcePath)}/wiki/summaries/${stem}-${sha256(sourcePath).slice(0, 16)}${languageSuffix}.md`;
}

function replacementDiff(path: string, previous: string | null, content: string): string {
  const removed = previous === null ? [] : previous.split('\n').map((line) => `-${line}`);
  const added = content.split('\n').map((line) => `+${line}`);
  return [`--- ${previous === null ? '/dev/null' : path}`, `+++ ${path}`, ...removed, ...added].join('\n');
}

function conceptKey(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('zh-CN').replaceAll(/[\s\p{P}\p{S}]+/gu, '');
}

function conceptPath(title: string, bundleRoot: string): string {
  const printable = [...title.normalize('NFC')]
    .map((character) => (character.codePointAt(0) ?? 0) < 32 ? '-' : character)
    .join('');
  const stem = printable.replaceAll(/[<>:"/\\|?*]/gu, '-').replaceAll(/\s+/gu, '-').replaceAll(/-+/gu, '-').slice(0, 48).replaceAll(/^[.-]+|[. -]+$/gu, '') || '未命名概念';
  return `${bundleRoot}/wiki/concepts/知识点-${stem}.md`;
}

function appendIndexLinks(content: string, concepts: readonly { readonly title: string; readonly path: string }[]): string {
  const additions = concepts.filter((concept) => !content.includes(`[[${concept.path}`));
  if (additions.length === 0) return content;
  const lines = additions.map((concept) => `- [[${concept.path}|${concept.title}]]`).join('\n');
  const heading = /^## 概念\s*$/mu;
  if (!heading.test(content)) return `${content.trimEnd()}\n\n## 概念\n\n${lines}\n`;
  const match = heading.exec(content);
  const insertAt = (match?.index ?? 0) + (match?.[0].length ?? 0);
  return `${content.slice(0, insertAt)}\n\n${lines}${content.slice(insertAt)}`;
}

function prependLog(content: string, date: string, concepts: readonly { readonly title: string; readonly action: 'create' | 'update' }[]): string {
  const lines = concepts.map((concept) => `- ${concept.action === 'create' ? '创建' : '更新'}概念：${concept.title}`).join('\n');
  const dateHeading = `## ${date}`;
  const index = content.indexOf(dateHeading);
  if (index >= 0) {
    const insertAt = index + dateHeading.length;
    return `${content.slice(0, insertAt)}\n\n${lines}${content.slice(insertAt)}`;
  }
  const titleMatch = /^#\s+.+$/mu.exec(content);
  const insertAt = titleMatch?.index === undefined ? 0 : titleMatch.index + titleMatch[0].length;
  return `${content.slice(0, insertAt)}\n\n${dateHeading}\n\n${lines}\n${content.slice(insertAt).replace(/^\s*/u, '')}`;
}

export class AISummaryService {
  private readonly pending = new Map<string, PendingRecord>();
  private readonly appliedSources = new Map<string, string>();

  constructor(
    private readonly repository: VaultRepository,
    private readonly configStore: AIDeviceConfigStore,
    private readonly providerOrResolver: AIProvider | LocalAIProviderResolver = defaultProvider,
    private readonly now: () => Date = () => new Date(),
    private readonly onlineAI?: OnlineAIService,
  ) {}

  async settings(): Promise<{ readonly providerId: LocalAIProviderId; readonly endpoint: string; readonly model: string; readonly contextWindow: number; readonly configured: boolean }> {
    const config = await this.configStore.load();
    return {
      ...config,
      contextWindow: normalizeAIContextWindow(config.contextWindow, DEFAULT_LOCAL_AI_CONTEXT_WINDOW),
      configured: Boolean(config.model),
    };
  }

  async probe(
    providerId: LocalAIProviderId,
    endpoint: string,
  ): Promise<readonly { readonly id: string; readonly displayName: string; readonly contextWindow?: number }[]> {
    const normalized = normalizeLocalAIEndpoint(providerId, endpoint);
    const models = await this.provider(providerId).listModels({ providerId, endpoint: normalized, model: '' });
    return models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    }));
  }

  async configure(
    providerId: LocalAIProviderId,
    endpoint: string,
    model: string,
    contextWindow: number = DEFAULT_LOCAL_AI_CONTEXT_WINDOW,
  ): Promise<ReturnType<AISummaryService['settings']> extends Promise<infer T> ? T : never> {
    const normalized = normalizeLocalAIEndpoint(providerId, endpoint);
    if (!model.trim()) throw new Error('请选择一个本地聊天模型。');
    const models = await this.provider(providerId).listModels({ providerId, endpoint: normalized, model: '' });
    const selectedModel = models.find((candidate) => candidate.id === model.trim());
    if (!selectedModel) throw new Error('所选模型不在本地服务返回的模型列表中。');
    if (selectedModel.contextWindow !== undefined && selectedModel.contextWindow < 8_192) {
      throw new Error(`当前加载模型的上下文只有 ${selectedModel.contextWindow.toLocaleString()} tokens，低于 Oldfolio 摘要所需的最低 8,192 tokens。请增大 Context Length 后重新加载模型。`);
    }
    const requestedContextWindow = normalizeAIContextWindow(contextWindow, DEFAULT_LOCAL_AI_CONTEXT_WINDOW);
    const effectiveContextWindow = selectedModel.contextWindow === undefined
      ? requestedContextWindow
      : Math.min(requestedContextWindow, selectedModel.contextWindow);
    await this.configStore.save({
      version: 1, providerId, endpoint: normalized, model: model.trim(),
      contextWindow: effectiveContextWindow,
    });
    return this.settings();
  }

  async prepare(
    sourcePath: string,
    executionTarget: AISummaryExecutionTarget = 'local',
    mode: TranscriptSummaryMode = 'fast',
    outputLanguage: TranscriptSummaryLanguage = 'auto',
  ): Promise<AISummaryPreparation> {
    if (mode === 'deep' && executionTarget !== 'online') throw new Error('深度摘要当前仅支持在线大模型。');
    const execution = await this.execution(executionTarget);
    let { config } = execution;
    if (executionTarget === 'local' && config.providerId === 'openai-compatible') {
      const models = await execution.provider.listModels(config, execution.context);
      const selected = models.find((model) => model.id === config.model);
      const configuredContextWindow = config.contextWindow ?? DEFAULT_LOCAL_AI_CONTEXT_WINDOW;
      if (selected?.contextWindow !== undefined && selected.contextWindow < 8_192) {
        throw new Error(`当前加载模型的上下文只有 ${selected.contextWindow.toLocaleString()} tokens，低于 Oldfolio 摘要所需的最低 8,192 tokens。请在 LM Studio 中增大 Context Length 后重新加载模型。`);
      }
      if (selected?.contextWindow !== undefined && selected.contextWindow < configuredContextWindow) {
        config = { ...config, contextWindow: selected.contextWindow };
        await this.configStore.save({
          version: 1,
          providerId: config.providerId as LocalAIProviderId,
          endpoint: config.endpoint,
          model: config.model,
          contextWindow: selected.contextWindow,
        });
      }
    }
    const prepared = await this.readPrepared(sourcePath, config.contextWindow, mode, outputLanguage);
    return {
      sourcePath: prepared.sourcePath,
      sourceRevision: prepared.sourceRevision,
      suggestedTemplate: prepared.suggestedTemplate,
      templateConfidence: prepared.templateConfidence,
      availableTemplates: SUMMARY_TEMPLATES,
      segmentCount: prepared.evidence.length,
      sourceCharacters: prepared.sourceCharacters,
      estimatedInputTokens: prepared.estimatedInputTokens,
      mode: prepared.mode,
      requestedOutputLanguage: prepared.requestedOutputLanguage,
      outputLanguage: prepared.outputLanguage,
      contextWindow: prepared.contextWindow,
      reservedOutputTokens: prepared.reservedOutputTokens,
      analysisOutputTokens: prepared.analysisOutputTokens,
      inputTokenBudget: prepared.inputTokenBudget,
      windowTokenBudget: prepared.windowTokenBudget,
      workingDocumentPath: prepared.workingDocumentPath,
      processingMode: prepared.processingMode,
      estimatedModelCalls: prepared.estimatedModelCalls,
      endpoint: config.endpoint,
      model: config.model,
      providerId: config.providerId as LocalAIProviderId,
      executionTarget,
      dataDestination: execution.dataDestination,
      estimatedCost: executionTarget === 'local' ? 0 : null,
      sourcePreview: prepared.workingDocumentContent,
    };
  }

  async generate(
    sourcePath: string,
    sourceRevision: string,
    template: SummaryTemplate,
    signal?: AbortSignal,
    executionTarget: AISummaryExecutionTarget = 'local',
    mode: TranscriptSummaryMode = 'fast',
    outputLanguage: TranscriptSummaryLanguage = 'auto',
  ): Promise<AIPendingSummaryChange> {
    if (!(SUMMARY_TEMPLATES as readonly string[]).includes(template)) throw new Error('摘要模板无效。');
    if (mode === 'deep' && executionTarget !== 'online') throw new Error('深度摘要当前仅支持在线大模型。');
    const execution = await this.execution(executionTarget, signal);
    const { config } = execution;
    const initialContextWindow = config.contextWindow ?? DEFAULT_LOCAL_AI_CONTEXT_WINDOW;
    let prepared = await this.readPrepared(sourcePath, config.contextWindow, mode, outputLanguage);
    if (prepared.sourceRevision !== sourceRevision) throw new Error('转录笔记已发生变化，请重新准备摘要。');
    await this.ensureWorkingDocument(prepared);
    let generated: Awaited<ReturnType<typeof generateTranscriptSummary>>;
    try {
      generated = await generateTranscriptSummary(
        execution.provider,
        config,
        prepared,
        template,
        execution.context,
      );
    } catch (error: unknown) {
      const configuredContextWindow = config.contextWindow ?? DEFAULT_LOCAL_AI_CONTEXT_WINDOW;
      const reportedContextWindow = error instanceof AIProviderError
        && error.code === 'CONTEXT_WINDOW_EXCEEDED'
        ? error.availableContextTokens
        : undefined;
      if (
        executionTarget !== 'local'
        || reportedContextWindow === undefined
        || reportedContextWindow < 8_192
        || reportedContextWindow >= configuredContextWindow
      ) throw error;

      const fallbackPrepared = await this.readPrepared(
        sourcePath,
        reportedContextWindow,
        mode,
        outputLanguage,
      );
      if (fallbackPrepared.sourceRevision !== sourceRevision) {
        throw new Error('转录笔记已发生变化，请重新准备摘要。');
      }
      await this.ensureWorkingDocument(fallbackPrepared);
      const fallbackConfig = { ...config, contextWindow: reportedContextWindow };
      generated = await generateTranscriptSummary(
        execution.provider,
        fallbackConfig,
        fallbackPrepared,
        template,
        execution.context,
      );
      prepared = fallbackPrepared;
      await this.configStore.save({
        version: 1,
        providerId: config.providerId as LocalAIProviderId,
        endpoint: config.endpoint,
        model: config.model,
        contextWindow: reportedContextWindow,
      });
    }
    const targetPath = summaryPath(sourcePath, prepared.requestedOutputLanguage);
    const existing = await this.readOptional(targetPath);
    const logicalId = `synthesis-${sha256(`${sourcePath}:${prepared.requestedOutputLanguage}`).slice(0, 24)}`;
    const body = [
      `# ${markdownText(generated.summary.title)}`,
      '',
      `> 来源：[[${sourcePath}|原始转录]]`,
      `> 摘要方式：${summaryTemplateLabels[generated.template]}`,
      `> 生成模式：${generated.mode === 'deep' ? '深度摘要（思考分析 + 编辑润色）' : '快速摘要'}`,
      `> 输出语言：${generated.outputLanguage === 'zh-CN' ? '简体中文' : 'English'}`,
      '> 提示：本笔记根据自动转录生成；原转录可能存在识别错误，可打开上方原始转录核对。',
      '',
      generated.summary.markdown,
    ].join('\n');
    const content = serializeNewOkfConcept({
      frontmatter: {
        type: 'Synthesis',
        title: generated.summary.title,
        description: `AI-maintained readable ${generated.template} summary.`,
        sources: [{ resource: sourcePath, id: `transcript-${sha256(sourcePath).slice(0, 24)}`, title: prepared.title }],
        status: 'draft',
        generated: { by: `${config.providerId}:${generated.completion.model}`, at: this.now().toISOString() },
        oldfolio: {
          id: logicalId,
          source_path: sourcePath,
          source_revision: sourceRevision,
          summary_template: generated.template,
          summary_mode: generated.mode,
          summary_language: generated.outputLanguage,
          requested_summary_language: prepared.requestedOutputLanguage,
          prompt_version: generated.promptVersion,
        },
      },
      body,
    });
    const citationIds: string[] = [];
    const citations: WikiCitation[] = [];
    const source = await this.repository.read(sourcePath);
    const baseRevisions = [revision(source), ...(existing ? [revision(existing)] : [])];
    const operation = existing
      ? { kind: 'update' as const, path: targetPath, baseRevision: revision(existing), content, contentHash: sha256(content) }
      : { kind: 'create' as const, path: targetPath, content, contentHash: sha256(content) };
    const riskLevel = existing ? 'L2' as const : 'L1' as const;
    const diff = replacementDiff(targetPath, existing?.text ?? null, content);
    const changeSet = await createWikiChangeSet({
      baseRevisions,
      sourceHashes: { [sourcePath]: sourceRevision },
      generator: { providerId: config.providerId, model: generated.completion.model, promptVersion: generated.promptVersion },
      riskLevel,
      items: [{
        id: `summary-${sha256(`${sourcePath}:${sourceRevision}:${prepared.requestedOutputLanguage}`).slice(0, 16)}`,
        summary: existing ? '更新 AI 摘要' : '创建 AI 摘要',
        riskLevel,
        operation,
        diff,
        citationIds,
      }],
      citations,
      createdAt: this.now().toISOString(),
    });
    this.pending.set(changeSet.id, { changeSet, targetPath, sourcePath });
    while (this.pending.size > 10) this.pending.delete(this.pending.keys().next().value as string);
    return {
      id: changeSet.id,
      riskLevel,
      targetPath,
      sourcePath,
      template,
      outputLanguage: generated.outputLanguage,
      contextWindow: prepared.contextWindow,
      contextWindowAdjusted: prepared.contextWindow < initialContextWindow,
      content,
      diff,
      citations,
      model: generated.completion.model,
      ...(generated.completion.usage ? { usage: generated.completion.usage } : {}),
    };
  }

  async prepareConcepts(
    sourcePath: string,
    executionTarget: AISummaryExecutionTarget = 'local',
  ): Promise<AIConceptPreparation> {
    const source = await this.readSummarySource(sourcePath);
    const execution = await this.execution(executionTarget);
    const existing = await this.existingConcepts(knowledgeBundleRoot(source.snapshot.path));
    return {
      sourcePath: source.snapshot.path,
      sourceRevision: source.snapshot.revision,
      sourceTitle: source.title,
      existingConceptCount: existing.length,
      sourceCharacters: source.parsed.body.length,
      endpoint: execution.config.endpoint,
      model: execution.config.model,
      providerId: execution.config.providerId as LocalAIProviderId,
      executionTarget,
      dataDestination: execution.dataDestination,
      estimatedCost: executionTarget === 'local' ? 0 : null,
      sourcePreview: source.parsed.body.trim(),
    };
  }

  async generateConcepts(
    sourcePath: string,
    sourceRevision: string,
    signal?: AbortSignal,
    executionTarget: AISummaryExecutionTarget = 'local',
  ): Promise<AIPendingConceptChange> {
    const source = await this.readSummarySource(sourcePath);
    if (source.snapshot.revision !== sourceRevision) throw new Error('摘要笔记已发生变化，请重新准备概念提取。');
    const bundleRoot = knowledgeBundleRoot(source.snapshot.path);
    const existingConcepts = await this.existingConcepts(bundleRoot);
    const execution = await this.execution(executionTarget, signal);
    const generated = await generateConceptsFromSummary(execution.provider, execution.config, {
      sourcePath,
      sourceTitle: source.title,
      sourceMarkdown: source.snapshot.text,
      existingConcepts: existingConcepts.map((concept) => ({
        title: concept.title,
        path: concept.snapshot.path,
        excerpt: concept.parsed.body.slice(0, 1_500),
      })),
    }, execution.context);

    const existingByTitle = new Map(existingConcepts.map((concept) => [conceptKey(concept.title), concept]));
    const generatedAt = this.now().toISOString();
    const conceptChanges: {
      readonly title: string;
      readonly path: string;
      readonly action: 'create' | 'update';
      readonly snapshot: VaultFileSnapshot | null;
      readonly content: string;
    }[] = [];
    const generatedKeys = new Set<string>();
    for (const concept of generated.concepts) {
      const key = conceptKey(concept.title);
      if (!key || generatedKeys.has(key)) continue;
      generatedKeys.add(key);
      const existing = existingByTitle.get(key);
      const path = existing?.snapshot.path ?? conceptPath(concept.title, bundleRoot);
      const existingSources = existing?.parsed.frontmatter?.sources ?? [];
      const sources = [
        ...existingSources,
        ...existingSources.some((item) => item.resource === sourcePath)
          ? []
          : [{ resource: sourcePath, id: `synthesis-${sha256(sourcePath).slice(0, 24)}`, title: source.title }],
      ];
      const stableId = existing?.parsed.frontmatter?.oldfolio?.id
        ?? `concept-${sha256(`${bundleRoot}:${key}`).slice(0, 24)}`;
      const content = serializeNewOkfConcept({
        frontmatter: {
          ...(existing?.parsed.frontmatter ?? {}),
          type: 'Concept',
          title: concept.title,
          description: `可复用知识概念：${concept.title}`,
          sources,
          status: 'draft',
          generated: { by: `${execution.config.providerId}:${generated.completion.model}`, at: generatedAt },
          oldfolio: {
            ...(existing?.parsed.frontmatter?.oldfolio ?? {}),
            id: stableId,
            prompt_version: generated.promptVersion,
            last_source_path: sourcePath,
            last_source_revision: sourceRevision,
          },
        },
        body: concept.markdown,
      });
      conceptChanges.push({
        title: concept.title,
        path,
        action: existing ? 'update' : 'create',
        snapshot: existing?.snapshot ?? null,
        content,
      });
    }
    if (conceptChanges.length === 0) throw new Error('模型没有提取出可写入的知识概念。');

    const indexSnapshot = await this.repository.read(`${bundleRoot}/index.md`);
    const logSnapshot = await this.repository.read(`${bundleRoot}/log.md`);
    const indexContent = appendIndexLinks(indexSnapshot.text, conceptChanges);
    const logContent = prependLog(logSnapshot.text, generatedAt.slice(0, 10), conceptChanges);
    const managedChanges = [
      ...conceptChanges,
      { title: '知识包目录', path: indexSnapshot.path, action: 'update' as const, snapshot: indexSnapshot, content: indexContent },
      { title: '知识包变更日志', path: logSnapshot.path, action: 'update' as const, snapshot: logSnapshot, content: logContent },
    ];
    const hasConceptUpdate = conceptChanges.some((concept) => concept.action === 'update');
    const riskLevel = hasConceptUpdate ? 'L2' as const : 'L1' as const;
    const citationId = `source-${sha256(`${sourcePath}:${sourceRevision}`).slice(0, 16)}`;
    const citations: WikiCitation[] = [{
      id: citationId,
      sourceId: source.parsed.frontmatter?.oldfolio?.id ?? `synthesis-${sha256(sourcePath).slice(0, 24)}`,
      resource: sourcePath,
      title: source.title,
    }];
    const items = managedChanges.map((change, index) => {
      const itemRisk = change.action === 'update' && change.path.includes('/wiki/') ? 'L2' as const : 'L1' as const;
      const operation = change.action === 'create'
        ? { kind: 'create' as const, path: change.path, content: change.content, contentHash: sha256(change.content) }
        : { kind: 'update' as const, path: change.path, baseRevision: revision(change.snapshot!), content: change.content, contentHash: sha256(change.content) };
      return {
        id: `concept-change-${index + 1}-${sha256(change.path).slice(0, 12)}`,
        summary: `${change.action === 'create' ? '创建' : '更新'}${change.title}`,
        riskLevel: itemRisk,
        operation,
        diff: replacementDiff(change.path, change.snapshot?.text ?? null, change.content),
        citationIds: change.path.includes('/wiki/concepts/') ? [citationId] : [],
      };
    });
    const baseRevisions = [
      revision(source.snapshot),
      revision(indexSnapshot),
      revision(logSnapshot),
      ...conceptChanges.flatMap((concept) => concept.snapshot ? [revision(concept.snapshot)] : []),
    ];
    const changeSet = await createWikiChangeSet({
      baseRevisions,
      sourceHashes: { [sourcePath]: sourceRevision },
      generator: {
        providerId: execution.config.providerId,
        model: generated.completion.model,
        promptVersion: generated.promptVersion,
      },
      riskLevel,
      items,
      citations,
      createdAt: generatedAt,
    });
    const targetPath = conceptChanges[0]!.path;
    this.pending.set(changeSet.id, { changeSet, targetPath, sourcePath });
    while (this.pending.size > 10) this.pending.delete(this.pending.keys().next().value as string);
    return {
      id: changeSet.id,
      riskLevel,
      targetPath,
      sourcePath,
      createdCount: conceptChanges.filter((concept) => concept.action === 'create').length,
      updatedCount: conceptChanges.filter((concept) => concept.action === 'update').length,
      conceptTitles: conceptChanges.map((concept) => concept.title),
      files: conceptChanges.map((concept) => ({ path: concept.path, action: concept.action, content: concept.content })),
      diff: items.map((item) => item.diff).join('\n\n'),
      model: generated.completion.model,
      ...(generated.completion.usage ? { usage: generated.completion.usage } : {}),
    };
  }

  async apply(changeSetId: string): Promise<AppliedChangeSet & { readonly targetPath: string }> {
    const pending = this.pending.get(changeSetId);
    if (!pending) throw new Error('AI 变更集不存在或已过期，请重新生成。');
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

  private async readPrepared(
    sourcePath: string,
    contextWindow?: number,
    mode: TranscriptSummaryMode = 'fast',
    outputLanguage: TranscriptSummaryLanguage = 'auto',
  ): Promise<PreparedTranscriptSummary> {
    const snapshot = await this.repository.read(sourcePath);
    const manifest = parseTranscriptPlaybackManifest(snapshot.text, snapshot.path);
    if (!manifest) throw new Error('当前文档不是带时间戳的 Oldfolio Transcript。');
    return prepareTranscriptSummary({
      sourcePath: snapshot.path,
      sourceRevision: snapshot.revision,
      title: manifest.title,
      resource: manifest.resource,
      segments: manifest.segments,
      mode,
      outputLanguage,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    });
  }

  private async readSummarySource(sourcePath: string): Promise<{
    readonly snapshot: VaultFileSnapshot;
    readonly parsed: ParsedOkfConcept;
    readonly title: string;
  }> {
    const snapshot = await this.repository.read(sourcePath);
    if (!/^bundles\/(?:personal|creators\/creator-[a-f0-9]{16})\/wiki\/summaries\//u.test(sourcePath)) {
      throw new Error('请选择由 Oldfolio 生成的摘要笔记。');
    }
    const parsed = parseOkfDocument(snapshot.text, sourcePath);
    if (!parsed.valid || parsed.kind !== 'concept' || parsed.frontmatter?.type !== 'Synthesis') {
      throw new Error('当前文档不是有效的 Oldfolio Synthesis 摘要。');
    }
    return { snapshot, parsed, title: parsed.frontmatter.title ?? parse(sourcePath).name };
  }

  private async existingConcepts(bundleRoot: string): Promise<readonly {
    readonly snapshot: VaultFileSnapshot;
    readonly parsed: ParsedOkfConcept;
    readonly title: string;
  }[]> {
    const snapshots = await this.repository.scanDocuments();
    return snapshots.flatMap((snapshot) => {
      if (!snapshot.path.startsWith(`${bundleRoot}/wiki/concepts/`)) return [];
      const parsed = parseOkfDocument(snapshot.text, snapshot.path);
      if (!parsed.valid || parsed.kind !== 'concept' || parsed.frontmatter?.type !== 'Concept') return [];
      return [{ snapshot, parsed, title: parsed.frontmatter.title ?? parse(snapshot.path).name }];
    });
  }

  private async ensureWorkingDocument(prepared: PreparedTranscriptSummary): Promise<void> {
    const existing = await this.readOptional(prepared.workingDocumentPath);
    if (existing) {
      if (existing.text !== prepared.workingDocumentContent) {
        throw new Error('AI 转录工作文件与当前来源修订不一致，请清理缓存后重试。');
      }
      return;
    }
    await this.repository.write(prepared.workingDocumentPath, prepared.workingDocumentContent, null);
  }

  private provider(providerId: LocalAIProviderId): AIProvider {
    return typeof this.providerOrResolver === 'function'
      ? this.providerOrResolver(providerId)
      : this.providerOrResolver;
  }

  private async execution(
    target: AISummaryExecutionTarget,
    signal?: AbortSignal,
  ): Promise<{
    readonly provider: AIProvider;
    readonly config: AIProviderConfig;
    readonly context: AIInvocationContext;
    readonly dataDestination: AISummaryPreparation['dataDestination'];
  }> {
    if (target === 'online') {
      if (!this.onlineAI) throw new Error('在线 AI 服务尚未初始化。');
      const runtime = await this.onlineAI.runtime(signal);
      return {
        provider: runtime.provider,
        config: runtime.config,
        context: runtime.context,
        dataDestination: 'online_openai_compatible',
      };
    }
    const config = await this.configStore.load();
    if (!config.model) throw new Error('请先连接本地 AI 服务并选择模型。');
    return {
      provider: this.provider(config.providerId),
      config,
      context: {
        resolveSecret: () => Promise.resolve(undefined),
        ...(signal ? { signal } : {}),
      },
      dataDestination: config.providerId === 'ollama' ? 'local_ollama' : 'local_lm_studio',
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
