import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OnlineAIConfigStore,
  OnlineAIService,
  SessionSecretStore,
  normalizeOnlineAIEndpoint,
} from './online-ai.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('online AI device boundary', () => {
  it('requires HTTPS and explicit host confirmation', () => {
    expect(() => normalizeOnlineAIEndpoint('https://api.example.test/v1', false)).toThrow(/确认/u);
    expect(() => normalizeOnlineAIEndpoint('http://api.example.test/v1', true)).toThrow(/HTTPS/iu);
    expect(normalizeOnlineAIEndpoint('https://api.example.test', true).href).toBe('https://api.example.test/v1/');
  });

  it('keeps the API key in session memory and persists only a secret reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-online-ai-'));
    roots.push(root);
    const configPath = join(root, 'device', 'online-ai.json');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'chat-model' }, { id: 'transcribe-model' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const secrets = new SessionSecretStore();
    const service = new OnlineAIService(
      new OnlineAIConfigStore(configPath),
      secrets,
      fetchMock,
      () => Promise.reject(new Error('not used')),
    );

    await expect(service.probe('https://api.example.test/v1', 'test-secret', true)).resolves.toHaveLength(2);
    await service.configure({
      endpoint: 'https://api.example.test/v1',
      chatModel: 'chat-model',
      transcriptionModel: 'transcribe-model',
      apiKey: 'test-secret',
      hostConfirmed: true,
    });

    expect(await service.settings()).toMatchObject({ configured: true, keyAvailable: true });
    const persisted = await readFile(configPath, 'utf8');
    expect(persisted).toContain('session:online-openai-compatible');
    expect(persisted).not.toContain('test-secret');
    expect(JSON.stringify(service)).not.toContain('test-secret');
    service.clearSessionKey();
    expect(await service.settings()).toMatchObject({ keyAvailable: false });
    await expect(service.runtime()).rejects.toThrow(/重新输入/u);
  });
});

