import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AIProvider } from '@oldfolio/domain';
import { compileTranscriptDocument } from '@oldfolio/media';
import { parseOkfDocument, serializeNewOkfConcept } from '@oldfolio/okf';
import { VaultNotFoundError, VaultRepository } from '@oldfolio/vault';
import { afterEach, describe, expect, it } from 'vitest';

import { AIDeviceConfigStore } from './ai-device-config.js';
import { AIWikiChatService } from './ai-wiki-chat.js';

const roots: string[] = [];
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop Wiki question workflow', () => {
  it('prefers maintained Wiki, falls back to transcripts, and saves only after approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-wiki-chat-'));
    roots.push(root);
    const vault = await VaultRepository.open(join(root, 'vault'));
    await vault.initialize();
    const conceptPath = 'bundles/personal/wiki/concepts/知识点-本地优先.md';
    await vault.write(conceptPath, serializeNewOkfConcept({
      frontmatter: { type: 'Concept', title: '本地优先', oldfolio: { id: 'concept-local-first' } },
      body: '# 本地优先\n\n## 摘要\n\n本地优先让本地文件成为权威状态。localfirsttoken',
    }), null);
    const transcript = compileTranscriptDocument({
      sourceId: 'source-local-first', sourceHash: sha256('source'), sourceResource: 'assets/media/local-first.mp4',
      sourceTitle: '本地优先访谈',
      transcript: { text: '本地优先也可以使用用户自己的同步服务。localfirsttoken', segments: [{ startMs: 0, endMs: 2_000, text: '本地优先也可以使用用户自己的同步服务。localfirsttoken' }] },
      generatedAt: '2026-08-23T00:00:00.000Z', generator: 'test',
    });
    await vault.write(transcript.path, transcript.content, null);
    await vault.rebuildIndex();
    const store = new AIDeviceConfigStore(join(root, 'ai.json'));
    await store.save({ version: 1, providerId: 'ollama', endpoint: 'http://127.0.0.1:11434/api/', model: 'test' });
    const provider: AIProvider = {
      id: 'ollama', displayName: 'Fake', capabilities: ['chat'], listModels: () => Promise.resolve([]),
      complete: () => Promise.resolve({
        content: `本地文件是权威状态 [[${conceptPath}|本地优先]]，必要时通过用户自己的服务同步。`,
        model: 'test', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 40 },
      }),
    };
    const service = new AIWikiChatService(vault, store, () => provider, () => new Date('2026-08-23T12:00:00.000Z'));
    const preparation = await service.prepare('请问 localfirsttoken 是什么？', 'local');
    expect(preparation.sources[0]).toMatchObject({ path: conceptPath, kind: 'wiki' });
    expect(preparation).toMatchObject({ usedTranscriptFallback: true, estimatedCost: 0 });
    expect(preparation.sources.some((source) => source.kind === 'transcript')).toBe(true);

    const answer = await service.answer(preparation.id);
    expect(answer.markdown).toContain(`[[${conceptPath}|本地优先]]`);
    expect(answer.markdown).toContain('## 参考知识');
    const pending = await service.prepareSave(answer.id);
    expect(pending).toMatchObject({ riskLevel: 'L1' });
    await expect(vault.read(pending.targetPath)).rejects.toBeInstanceOf(VaultNotFoundError);

    const applied = await service.apply(pending.id);
    const saved = await vault.read(applied.targetPath);
    const parsed = parseOkfDocument(saved.text, saved.path);
    expect(parsed.valid).toBe(true);
    if (parsed.kind !== 'concept') throw new Error('Expected saved QA concept');
    expect(parsed.frontmatter).toMatchObject({ type: 'Synthesis', oldfolio: { question: '请问 localfirsttoken 是什么？' } });
    expect(parsed.body).toContain('本地文件是权威状态');
    expect((await vault.read('bundles/personal/index.md')).text).toContain(`[[${applied.targetPath}|`);
    expect((await vault.read('bundles/personal/log.md')).text).toContain('保存问答');

    await service.undo(applied.historyId);
    await expect(vault.read(applied.targetPath)).rejects.toBeInstanceOf(VaultNotFoundError);
    vault.close();
  });

  it('rejects an answer when a reviewed source revision changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-wiki-chat-stale-'));
    roots.push(root);
    const vault = await VaultRepository.open(join(root, 'vault'));
    await vault.initialize();
    const conceptPath = 'bundles/personal/wiki/concepts/知识点-修订检查.md';
    await vault.write(conceptPath, serializeNewOkfConcept({
      frontmatter: { type: 'Concept', title: '修订检查', oldfolio: { id: 'concept-revision-check' } },
      body: '# 修订检查\n\n知识页面修订后必须重新检索。',
    }), null);
    await vault.rebuildIndex();
    const store = new AIDeviceConfigStore(join(root, 'ai.json'));
    await store.save({ version: 1, providerId: 'ollama', endpoint: 'http://127.0.0.1:11434/api/', model: 'test' });
    const provider: AIProvider = {
      id: 'ollama', displayName: 'Fake', capabilities: ['chat'], listModels: () => Promise.resolve([]),
      complete: () => { throw new Error('must not call provider'); },
    };
    const service = new AIWikiChatService(vault, store, () => provider);
    const preparation = await service.prepare('修订检查', 'local');
    const current = await vault.read(conceptPath);
    await vault.write(conceptPath, `${current.text}\n`, current.revision);
    await expect(service.answer(preparation.id)).rejects.toThrow(/发生变化/u);
    vault.close();
  });
});
