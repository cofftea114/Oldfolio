import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AIProvider } from '@oldfolio/domain';
import { compileTranscriptDocument } from '@oldfolio/media';
import { parseOkfDocument } from '@oldfolio/okf';
import { VaultNotFoundError, VaultRepository } from '@oldfolio/vault';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AIDeviceConfigStore,
  normalizeLocalAIEndpoint,
  normalizeLocalOllamaEndpoint,
} from './ai-device-config.js';
import { AISummaryService, createLocalAIProviderResolver } from './ai-summary.js';

const roots: string[] = [];
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop AI summary workflow', () => {
  it('normalizes an LM Studio root URL to its native v1 API', () => {
    expect(normalizeLocalAIEndpoint('openai-compatible', 'http://127.0.0.1:1234')).toBe(
      'http://127.0.0.1:1234/api/v1/',
    );
  });

  it('stores only local AI device configuration and rejects remote endpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-ai-config-'));
    roots.push(root);
    const configPath = join(root, 'device', 'ai.json');
    const store = new AIDeviceConfigStore(configPath);
    expect(await store.load()).toMatchObject({ providerId: 'ollama', model: '' });
    expect(normalizeLocalOllamaEndpoint('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/api/');
    await store.save({
      version: 1,
      providerId: 'ollama',
      endpoint: 'http://localhost:11434/api',
      model: 'qwen3:8b',
      contextWindow: 32_768,
    });
    expect(await store.load()).toMatchObject({
      endpoint: 'http://localhost:11434/api/', model: 'qwen3:8b', contextWindow: 32_768,
    });
    expect(await readFile(configPath, 'utf8')).not.toContain('apiKey');
    expect(() => normalizeLocalOllamaEndpoint('https://models.example.test/api/')).toThrow(/本机 AI/);
  });

  it('routes LM Studio model discovery through the native v1 endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-lm-studio-'));
    roots.push(root);
    const vault = await VaultRepository.open(join(root, 'vault'));
    await vault.initialize();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      models: [{
        type: 'llm', key: 'google/gemma-4-e4b', display_name: 'Gemma 4 E4B', max_context_length: 1_000_000,
        loaded_instances: [{ config: { context_length: 131_072 } }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const lmStudio = createLocalAIProviderResolver(fetchMock)('openai-compatible');
    const configStore = new AIDeviceConfigStore(join(root, 'ai.json'));
    const service = new AISummaryService(
      vault,
      configStore,
      (providerId) => {
        expect(providerId).toBe('openai-compatible');
        return lmStudio;
      },
    );
    await expect(service.probe('openai-compatible', 'http://127.0.0.1:1234')).resolves.toEqual([
      { id: 'google/gemma-4-e4b', displayName: 'Gemma 4 E4B', contextWindow: 131_072 },
    ]);
    const requestedUrl = fetchMock.mock.calls[0]?.[0];
    expect(requestedUrl).toBeInstanceOf(URL);
    expect(requestedUrl instanceof URL ? requestedUrl.href : '').toBe('http://127.0.0.1:1234/api/v1/models');
    await service.configure('openai-compatible', 'http://127.0.0.1:1234', 'google/gemma-4-e4b', 131_072);
    expect(await configStore.load()).toMatchObject({
      providerId: 'openai-compatible',
      endpoint: 'http://127.0.0.1:1234/api/v1/',
      model: 'google/gemma-4-e4b',
      contextWindow: 131_072,
    });
    vault.close();
  });

  it('previews, applies, and atomically undoes a cited summary change set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-ai-summary-'));
    roots.push(root);
    const vault = await VaultRepository.open(join(root, 'vault'));
    await vault.initialize();
    const transcript = compileTranscriptDocument({
      sourceId: 'source-lesson',
      sourceHash: sha256('source'),
      sourceResource: 'assets/media/lesson.mp4',
      sourceTitle: '安装教程',
      transcript: {
        text: '先备份。然后安装并检查版本。',
        segments: [
          { startMs: 1_000, endMs: 4_000, text: '安装前先备份配置。' },
          { startMs: 8_000, endMs: 12_000, text: '执行安装，然后检查版本。' },
        ],
      },
      generatedAt: '2026-08-14T00:00:00.000Z',
      generator: 'test',
    });
    await vault.write(transcript.path, transcript.content, null);
    const store = new AIDeviceConfigStore(join(root, 'device', 'ai.json'));
    await store.save({
      version: 1, providerId: 'ollama', endpoint: 'http://127.0.0.1:11434/api/', model: 'qwen3:8b',
    });
    const provider: AIProvider = {
      id: 'ollama',
      displayName: 'Fake Ollama',
      capabilities: ['chat'],
      listModels: () => Promise.resolve([{ id: 'qwen3:8b', displayName: 'qwen3:8b', capabilities: ['chat'], local: true }]),
      complete: (_config, request) => {
        expect(request.messages.at(-1)?.content).toContain('segment-00002');
        return Promise.resolve({
          content: '# 安装教程摘要\n\n## 准备与验证\n\n安装流程包含准备和验证两个阶段。\n\n- 先备份配置。\n- 安装后检查版本。\n\n## 总结与启发\n\n先备份，再安装，最后验证。',
          model: 'qwen3:8b',
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 80 },
        });
      },
    };
    const service = new AISummaryService(vault, store, provider, () => new Date('2026-08-14T01:00:00.000Z'));
    const preparation = await service.prepare(transcript.path);
    expect(preparation).toMatchObject({
      dataDestination: 'local_ollama', estimatedCost: 0, suggestedTemplate: 'tutorial', segmentCount: 2,
      contextWindow: 8_192, processingMode: 'direct', estimatedModelCalls: 1,
    });
    const pending = await service.generate(transcript.path, preparation.sourceRevision, preparation.suggestedTemplate);
    expect(pending).toMatchObject({ riskLevel: 'L1', model: 'qwen3:8b', usage: { inputTokens: 100, outputTokens: 80 } });
    expect(pending.content).toContain('## 准备与验证');
    expect(pending.content).toContain('## 总结与启发');
    expect(pending.content).not.toContain('[定位');
    expect(pending.content).not.toContain('segment-');
    const workingDocument = await vault.read(`.oldfolio/cache/ai-inputs/${preparation.sourceRevision}.txt`);
    expect(workingDocument.text).toContain('[segment-00001 00:00:01.000]');
    await expect(vault.read(pending.targetPath)).rejects.toBeInstanceOf(VaultNotFoundError);

    const applied = await service.apply(pending.id);
    const summary = await vault.read(applied.targetPath);
    const parsed = parseOkfDocument(summary.text, applied.targetPath.replace('bundles/personal/', ''));
    expect(parsed.valid).toBe(true);
    expect(parsed.frontmatter).toMatchObject({
      type: 'Synthesis', oldfolio: { summary_template: 'tutorial', source_path: transcript.path },
    });
    expect((await vault.read(transcript.path)).text).toBe(transcript.content);

    const updatePreview = await service.generate(
      transcript.path,
      preparation.sourceRevision,
      preparation.suggestedTemplate,
    );
    expect(updatePreview).toMatchObject({ riskLevel: 'L2', targetPath: applied.targetPath });

    const undone = await service.undo(applied.historyId);
    expect(undone.sourcePath).toBe(transcript.path);
    await expect(vault.read(applied.targetPath)).rejects.toBeInstanceOf(VaultNotFoundError);
    vault.close();
  });

  it('rejects generation when the reviewed transcript revision became stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-ai-stale-'));
    roots.push(root);
    const vault = await VaultRepository.open(join(root, 'vault'));
    await vault.initialize();
    const transcript = compileTranscriptDocument({
      sourceId: 'source-stale', sourceHash: sha256('source'), sourceResource: 'assets/media/a.mp4',
      transcript: { text: 'Evidence', segments: [{ startMs: 0, endMs: 1_000, text: 'Evidence' }] },
      generatedAt: '2026-08-14T00:00:00.000Z', generator: 'test',
    });
    await vault.write(transcript.path, transcript.content, null);
    const store = new AIDeviceConfigStore(join(root, 'ai.json'));
    await store.save({ version: 1, providerId: 'ollama', endpoint: 'http://127.0.0.1:11434/api/', model: 'test' });
    const provider: AIProvider = {
      id: 'ollama', displayName: 'Fake', capabilities: ['chat'], listModels: () => Promise.resolve([]),
      complete: () => { throw new Error('must not call provider'); },
    };
    const service = new AISummaryService(vault, store, provider);
    const preparation = await service.prepare(transcript.path);
    const current = await vault.read(transcript.path);
    await vault.write(transcript.path, `${current.text}\n`, current.revision);
    await expect(service.generate(transcript.path, preparation.sourceRevision, preparation.suggestedTemplate)).rejects.toThrow(/发生变化/);
    vault.close();
  });
});
