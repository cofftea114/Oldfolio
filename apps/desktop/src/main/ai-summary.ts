import { createHash } from 'node:crypto';
import { parse } from 'node:path';

import {
  OllamaProvider,
  SUMMARY_TEMPLATES,
  createWikiChangeSet,
  generateTranscriptSummary,
  prepareTranscriptSummary,
  type PreparedTranscriptSummary,
  type SummaryEvidence,
  type SummaryTemplate,
} from '@oldfolio/ai';
import type {
  AIProvider,
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

import { normalizeLocalOllamaEndpoint } from './ai-device-config.js';
import type { AIDeviceConfigStore } from './ai-device-config.js';

export interface AISummaryPreparation {
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly suggestedTemplate: SummaryTemplate;
  readonly templateConfidence: number;
  readonly availableTemplates: readonly SummaryTemplate[];
  readonly segmentCount: number;
  readonly sourceCharacters: number;
  readonly estimatedInputTokens: number;
  readonly endpoint: string;
  readonly model: string;
  readonly dataDestination: 'local_ollama';
  readonly estimatedCost: 0;
  readonly sourcePreview: string;
}

export interface AIPendingSummaryChange {
  readonly id: string;
  readonly riskLevel: 'L1' | 'L2';
  readonly targetPath: string;
  readonly sourcePath: string;
  readonly template: SummaryTemplate;
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

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function revision(snapshot: VaultFileSnapshot): DocumentRevision {
  return {
    path: snapshot.path,
    revisionId: snapshot.revision,
    contentHash: snapshot.revision,
    modifiedAt: snapshot.modifiedAt.toISOString(),
    byteLength: snapshot.size,
  };
}

function displayTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
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

function citationLink(resource: string, evidence: SummaryEvidence): string {
  const separator = resource.includes('#') ? '&' : '#';
  return `[${displayTime(evidence.startMs)}](${resource}${separator}t=${(evidence.startMs / 1_000).toFixed(3)})`;
}

function summaryPath(sourcePath: string): string {
  const stem = parse(sourcePath).name.normalize('NFC').replaceAll(/[^a-zA-Z0-9._-]/gu, '-').replaceAll(/-+/gu, '-').slice(0, 52) || 'transcript';
  return `bundles/personal/wiki/summaries/${stem}-${sha256(sourcePath).slice(0, 16)}.md`;
}

function replacementDiff(path: string, previous: string | null, content: string): string {
  const removed = previous === null ? [] : previous.split('\n').map((line) => `-${line}`);
  const added = content.split('\n').map((line) => `+${line}`);
  return [`--- ${previous === null ? '/dev/null' : path}`, `+++ ${path}`, ...removed, ...added].join('\n');
}

function collectEvidenceIds(summary: {
  readonly overview: { readonly evidenceIds: readonly string[] };
  readonly keyPoints: readonly { readonly evidenceIds: readonly string[] }[];
  readonly concepts: readonly { readonly evidenceIds: readonly string[] }[];
}): string[] {
  return [...new Set([
    ...summary.overview.evidenceIds,
    ...summary.keyPoints.flatMap((item) => item.evidenceIds),
    ...summary.concepts.flatMap((item) => item.evidenceIds),
  ])];
}

export class AISummaryService {
  private readonly pending = new Map<string, PendingRecord>();
  private readonly appliedSources = new Map<string, string>();

  constructor(
    private readonly repository: VaultRepository,
    private readonly configStore: AIDeviceConfigStore,
    private readonly provider: AIProvider = new OllamaProvider(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async settings(): Promise<{ readonly providerId: 'ollama'; readonly endpoint: string; readonly model: string; readonly configured: boolean }> {
    const config = await this.configStore.load();
    return { ...config, configured: Boolean(config.model) };
  }

  async probe(endpoint: string): Promise<readonly { readonly id: string; readonly displayName: string }[]> {
    const normalized = normalizeLocalOllamaEndpoint(endpoint);
    const models = await this.provider.listModels({ providerId: 'ollama', endpoint: normalized, model: '' });
    return models.map((model) => ({ id: model.id, displayName: model.displayName }));
  }

  async configure(endpoint: string, model: string): Promise<ReturnType<AISummaryService['settings']> extends Promise<infer T> ? T : never> {
    const normalized = normalizeLocalOllamaEndpoint(endpoint);
    if (!model.trim()) throw new Error('请选择一个 Ollama 模型。');
    const models = await this.provider.listModels({ providerId: 'ollama', endpoint: normalized, model: '' });
    if (!models.some((candidate) => candidate.id === model.trim())) throw new Error('所选模型不在 Ollama 返回的模型列表中。');
    await this.configStore.save({ version: 1, providerId: 'ollama', endpoint: normalized, model: model.trim() });
    return this.settings();
  }

  async prepare(sourcePath: string): Promise<AISummaryPreparation> {
    const config = await this.configStore.load();
    if (!config.model) throw new Error('请先连接 Ollama 并选择模型。');
    const prepared = await this.readPrepared(sourcePath);
    return {
      sourcePath: prepared.sourcePath,
      sourceRevision: prepared.sourceRevision,
      suggestedTemplate: prepared.suggestedTemplate,
      templateConfidence: prepared.templateConfidence,
      availableTemplates: SUMMARY_TEMPLATES,
      segmentCount: prepared.evidence.length,
      sourceCharacters: prepared.sourceCharacters,
      estimatedInputTokens: prepared.estimatedInputTokens,
      endpoint: config.endpoint,
      model: config.model,
      dataDestination: 'local_ollama',
      estimatedCost: 0,
      sourcePreview: prepared.sourcePayload,
    };
  }

  async generate(
    sourcePath: string,
    sourceRevision: string,
    template: SummaryTemplate,
    signal?: AbortSignal,
  ): Promise<AIPendingSummaryChange> {
    if (!(SUMMARY_TEMPLATES as readonly string[]).includes(template)) throw new Error('摘要模板无效。');
    const config = await this.configStore.load();
    if (!config.model) throw new Error('请先连接 Ollama 并选择模型。');
    const prepared = await this.readPrepared(sourcePath);
    if (prepared.sourceRevision !== sourceRevision) throw new Error('转录笔记已发生变化，请重新准备摘要。');
    const generated = await generateTranscriptSummary(this.provider, config, prepared, template, {
      resolveSecret: () => Promise.resolve(undefined),
      ...(signal ? { signal } : {}),
    });
    const targetPath = summaryPath(sourcePath);
    const existing = await this.readOptional(targetPath);
    const evidenceById = new Map(prepared.evidence.map((item) => [item.id, item]));
    const links = (ids: readonly string[]) => ids.map((id) => {
      const evidence = evidenceById.get(id);
      if (!evidence) throw new Error(`摘要引用了未知证据 ${id}。`);
      return citationLink(prepared.resource, evidence);
    }).join(' ');
    const logicalId = `synthesis-${sha256(sourcePath).slice(0, 24)}`;
    const body = [
      `# ${markdownText(generated.summary.title)}`,
      '',
      `> 来源：[[${sourcePath}]]`,
      `> 模板：${generated.template}`,
      '',
      '## 摘要',
      '',
      `${markdownText(generated.summary.overview.text)} ${links(generated.summary.overview.evidenceIds)}`,
      '',
      '## 核心要点',
      '',
      ...generated.summary.keyPoints.map((item) => `- ${markdownText(item.text)} ${links(item.evidenceIds)}`),
      '',
      '## 概念',
      '',
      ...(generated.summary.concepts.length === 0
        ? ['暂无单独概念。']
        : generated.summary.concepts.flatMap((item) => [
            `### ${markdownText(item.name)}`,
            '',
            `${markdownText(item.explanation)} ${links(item.evidenceIds)}`,
            '',
          ])),
    ].join('\n');
    const content = serializeNewOkfConcept({
      frontmatter: {
        type: 'Synthesis',
        title: generated.summary.title,
        description: `AI-maintained ${generated.template} summary with timestamped transcript evidence.`,
        sources: [{ resource: sourcePath, id: `transcript-${sha256(sourcePath).slice(0, 24)}`, title: prepared.title }],
        status: 'draft',
        generated: { by: `${config.providerId}:${generated.completion.model}`, at: this.now().toISOString() },
        oldfolio: {
          id: logicalId,
          source_path: sourcePath,
          source_revision: sourceRevision,
          summary_template: generated.template,
          prompt_version: generated.promptVersion,
        },
      },
      body,
    });
    const citationIds = collectEvidenceIds(generated.summary);
    const citations: WikiCitation[] = citationIds.map((id) => {
      const evidence = evidenceById.get(id);
      if (!evidence) throw new Error(`摘要引用了未知证据 ${id}。`);
      return {
        id,
        sourceId: sourcePath,
        resource: prepared.resource,
        excerpt: evidence.text,
        startMs: evidence.startMs,
        ...(evidence.endMs === undefined ? {} : { endMs: evidence.endMs }),
      };
    });
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
        id: `summary-${sha256(`${sourcePath}:${sourceRevision}`).slice(0, 16)}`,
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

  private async readPrepared(sourcePath: string): Promise<PreparedTranscriptSummary> {
    const snapshot = await this.repository.read(sourcePath);
    const manifest = parseTranscriptPlaybackManifest(snapshot.text, snapshot.path);
    if (!manifest) throw new Error('当前文档不是带时间戳的 Oldfolio Transcript。');
    return prepareTranscriptSummary({
      sourcePath: snapshot.path,
      sourceRevision: snapshot.revision,
      title: manifest.title,
      resource: manifest.resource,
      segments: manifest.segments,
    });
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
