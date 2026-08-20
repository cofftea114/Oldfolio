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
      contextWindow: 1_000_000,
      apiKey: 'test-secret',
      hostConfirmed: true,
    });

    expect(await service.settings()).toMatchObject({ configured: true, keyAvailable: true, contextWindow: 1_000_000 });
    const persisted = await readFile(configPath, 'utf8');
    expect(persisted).toContain('session:online-openai-compatible');
    expect(persisted).toContain('1000000');
    expect(persisted).not.toContain('test-secret');
    expect(JSON.stringify(service)).not.toContain('test-secret');
    service.clearSessionKey();
    expect(await service.settings()).toMatchObject({ keyAvailable: false });
    await expect(service.runtime()).rejects.toThrow(/重新输入/u);
  });

  it('disables Qwen thinking so structured summaries keep output budget for the final JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-online-qwen-'));
    roots.push(root);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      model: 'qwen3.7-plus',
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new OnlineAIService(
      new OnlineAIConfigStore(join(root, 'device', 'online-ai.json')),
      new SessionSecretStore(),
      fetchMock,
      () => Promise.reject(new Error('not used')),
    );
    await service.configure({
      preset: 'qwen',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
      chatModel: 'qwen3.7-plus',
      contextWindow: 1_000_000,
      apiKey: 'test-secret',
      hostConfirmed: true,
    });
    const runtime = await service.runtime();
    await runtime.provider.complete(runtime.config, {
      model: runtime.config.model,
      messages: [{ role: 'user', content: 'summary' }],
      maxOutputTokens: 8_192,
      responseFormat: 'json',
    }, runtime.context);
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body.');
    const body = JSON.parse(requestBody) as Record<string, unknown>;
    expect(body).toMatchObject({ enable_thinking: false, max_tokens: 8_192 });
  });

  it('disables DeepSeek V4 thinking with the provider-specific request shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-online-deepseek-'));
    roots.push(root);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      model: 'deepseek-v4-flash',
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const service = new OnlineAIService(
      new OnlineAIConfigStore(join(root, 'device', 'online-ai.json')),
      new SessionSecretStore(),
      fetchMock,
      () => Promise.reject(new Error('not used')),
    );
    await service.configure({
      preset: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/',
      chatModel: 'deepseek-v4-flash',
      contextWindow: 1_000_000,
      apiKey: 'test-secret',
      hostConfirmed: true,
    });
    const runtime = await service.runtime();
    await runtime.provider.complete(runtime.config, {
      model: runtime.config.model,
      messages: [{ role: 'user', content: 'summary' }],
      maxOutputTokens: 8_192,
      responseFormat: 'json',
    }, runtime.context);
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body.');
    const body = JSON.parse(requestBody) as Record<string, unknown>;
    expect(body).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 8_192 });
    expect(body).not.toHaveProperty('enable_thinking');

    await runtime.provider.complete(runtime.config, {
      model: runtime.config.model,
      messages: [{ role: 'user', content: 'deep analysis' }],
      maxOutputTokens: 32_768,
      reasoningMode: 'enabled',
      responseFormat: 'text',
    }, runtime.context);
    const analysisRequestBody = fetchMock.mock.calls[1]?.[1]?.body;
    if (typeof analysisRequestBody !== 'string') throw new Error('Expected a JSON request body.');
    const analysisBody = JSON.parse(analysisRequestBody) as Record<string, unknown>;
    expect(analysisBody).toMatchObject({
      thinking: { type: 'enabled' }, max_tokens: 32_768,
    });
  });
});
