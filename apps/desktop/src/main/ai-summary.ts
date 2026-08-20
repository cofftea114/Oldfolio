import { createHash } from 'node:crypto';
import { parse } from 'node:path';

import {
  OllamaProvider,
  LMStudioProvider,
  SUMMARY_TEMPLATES,
  createWikiChangeSet,
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
import { serializeNewOkfConcept } from '@oldfolio/okf';
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
  readonly content: string;
  readonly diff: string;
  readonly citations: readonly WikiCitation[];
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

function summaryPath(sourcePath: string, language: TranscriptSummaryLanguage): string {
  const stem = parse(sourcePath).name.normalize('NFC').replaceAll(/[^a-zA-Z0-9._-]/gu, '-').replaceAll(/-+/gu, '-').slice(0, 52) || 'transcript';
  const languageSuffix = language === 'auto' ? '' : `-${language.toLowerCase()}`;
  return `bundles/personal/wiki/summaries/${stem}-${sha256(sourcePath).slice(0, 16)}${languageSuffix}.md`;
}

function replacementDiff(path: string, previous: string | null, content: string): string {
  const removed = previous === null ? [] : previous.split('\n').map((line) => `-${line}`);
  const added = content.split('\n').map((line) => `+${line}`);
  return [`--- ${previous === null ? '/dev/null' : path}`, `+++ ${path}`, ...removed, ...added].join('\n');
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
    if (!models.some((candidate) => candidate.id === model.trim())) throw new Error('所选模型不在本地服务返回的模型列表中。');
    await this.configStore.save({
      version: 1, providerId, endpoint: normalized, model: model.trim(),
      contextWindow: normalizeAIContextWindow(contextWindow, DEFAULT_LOCAL_AI_CONTEXT_WINDOW),
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
    const { config } = execution;
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
    const prepared = await this.readPrepared(sourcePath, config.contextWindow, mode, outputLanguage);
    if (prepared.sourceRevision !== sourceRevision) throw new Error('转录笔记已发生变化，请重新准备摘要。');
    await this.ensureWorkingDocument(prepared);
    const generated = await generateTranscriptSummary(
      execution.provider,
      config,
      prepared,
      template,
      execution.context,
    );
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
      content,
      diff,
      citations,
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
