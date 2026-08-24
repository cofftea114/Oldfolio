import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceSecretStore, type SecretEncryption } from './device-secret-store.js';
import {
  OnlineAIConfigStore,
  OnlineAIService,
  ONLINE_SUMMARY_PRESETS,
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

  it('uses a session-only secret store when OS encryption is unavailable', async () => {
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

    expect(await service.settings()).toMatchObject({
      configured: true,
      keyAvailable: true,
      keyPersisted: false,
      secureStorageAvailable: false,
      contextWindow: 1_000_000,
    });
    const persisted = await readFile(configPath, 'utf8');
    expect(persisted).toContain('online-ai:custom');
    expect(persisted).toContain('1000000');
    expect(persisted).not.toContain('test-secret');
    expect(JSON.stringify(service)).not.toContain('test-secret');
    service.clearSessionKey();
    expect(await service.settings()).toMatchObject({ keyAvailable: false });
    await expect(service.runtime()).rejects.toThrow(/重新输入/u);
  });

  it('restores and clears an OS-encrypted API key across service restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-online-ai-persisted-'));
    roots.push(root);
    const configPath = join(root, 'device', 'online-ai.json');
    const secretPath = join(root, 'device', 'credentials.json');
    const encryption: SecretEncryption = {
      isAvailable: () => Promise.resolve(true),
      encrypt: (plainText) => Promise.resolve(Buffer.from(`encrypted:${plainText}`, 'utf8')),
      decrypt: (encrypted) => Promise.resolve({
        result: encrypted.toString('utf8').replace(/^encrypted:/u, ''),
        shouldReEncrypt: false,
      }),
    };
    const firstSecrets = new DeviceSecretStore(secretPath, encryption);
    await firstSecrets.initialize();
    const firstService = new OnlineAIService(
      new OnlineAIConfigStore(configPath), firstSecrets, fetch,
      () => Promise.reject(new Error('not used')),
    );

    await firstService.configure({
      endpoint: 'https://api.example.test/v1',
      chatModel: 'chat-model',
      transcriptionModel: 'transcribe-model',
      contextWindow: 128_000,
      apiKey: 'persistent-secret',
      hostConfirmed: true,
    });
    expect(await firstService.settings()).toMatchObject({
      keyAvailable: true, keyPersisted: true, secureStorageAvailable: true,
    });
    expect(await readFile(secretPath, 'utf8')).not.toContain('persistent-secret');

    const restoredSecrets = new DeviceSecretStore(secretPath, encryption);
    await restoredSecrets.initialize();
    const restoredService = new OnlineAIService(
      new OnlineAIConfigStore(configPath), restoredSecrets, fetch,
      () => Promise.reject(new Error('not used')),
    );
    expect(await restoredService.settings()).toMatchObject({ keyAvailable: true, keyPersisted: true });
    await restoredService.clearSavedKey();

    const clearedSecrets = new DeviceSecretStore(secretPath, encryption);
    await clearedSecrets.initialize();
    const clearedService = new OnlineAIService(
      new OnlineAIConfigStore(configPath), clearedSecrets, fetch,
      () => Promise.reject(new Error('not used')),
    );
    expect(await clearedService.settings()).toMatchObject({ keyAvailable: false, keyPersisted: false });
  });

  it('keeps provider API keys isolated when switching between DeepSeek and Qwen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-online-ai-providers-'));
    roots.push(root);
    const encryption: SecretEncryption = {
      isAvailable: () => Promise.resolve(true),
      encrypt: (plainText) => Promise.resolve(Buffer.from(`encrypted:${plainText}`, 'utf8')),
      decrypt: (encrypted) => Promise.resolve({
        result: encrypted.toString('utf8').replace(/^encrypted:/u, ''), shouldReEncrypt: false,
      }),
    };
    const secrets = new DeviceSecretStore(join(root, 'device', 'credentials.json'), encryption);
    await secrets.initialize();
    const service = new OnlineAIService(
      new OnlineAIConfigStore(join(root, 'device', 'online-ai.json')), secrets, fetch,
      () => Promise.reject(new Error('not used')),
    );

    await service.configure({
      preset: 'deepseek', endpoint: ONLINE_SUMMARY_PRESETS.deepseek.endpoint,
      chatModel: 'deepseek-chat', contextWindow: 128_000,
      apiKey: 'deepseek-secret', hostConfirmed: true,
    });
    await service.configure({
      preset: 'qwen', endpoint: ONLINE_SUMMARY_PRESETS.qwen.endpoint,
      chatModel: 'qwen3.7-plus', contextWindow: 128_000,
      apiKey: 'qwen-secret', hostConfirmed: true,
    });
    const restoredDeepSeek = await service.configure({
      preset: 'deepseek', endpoint: ONLINE_SUMMARY_PRESETS.deepseek.endpoint,
      chatModel: 'deepseek-chat', contextWindow: 128_000,
      apiKey: '', hostConfirmed: true,
    });
    expect(restoredDeepSeek).toMatchObject({ preset: 'deepseek', keyAvailable: true });
    expect(restoredDeepSeek.keyAvailablePresets).toContain('deepseek');
    expect(restoredDeepSeek.keyAvailablePresets).toContain('qwen');
    expect(restoredDeepSeek.keyPersistedPresets).toContain('deepseek');
    expect(restoredDeepSeek.keyPersistedPresets).toContain('qwen');

    const afterQwenClear = await service.clearSavedKey('qwen');
    expect(afterQwenClear.keyAvailablePresets).toContain('deepseek');
    expect(afterQwenClear.keyAvailablePresets).not.toContain('qwen');
    expect(afterQwenClear.keyAvailable).toBe(true);
  });

  it('migrates the previous single API key into the active provider slot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-online-ai-legacy-key-'));
    roots.push(root);
    const configPath = join(root, 'device', 'online-ai.json');
    const encryption: SecretEncryption = {
      isAvailable: () => Promise.resolve(true),
      encrypt: (plainText) => Promise.resolve(Buffer.from(`encrypted:${plainText}`, 'utf8')),
      decrypt: (encrypted) => Promise.resolve({
        result: encrypted.toString('utf8').replace(/^encrypted:/u, ''), shouldReEncrypt: false,
      }),
    };
    const secrets = new DeviceSecretStore(join(root, 'device', 'credentials.json'), encryption);
    await secrets.initialize();
    await secrets.persist('session:online-openai-compatible', 'legacy-deepseek-secret');
    await writeFile(configPath, JSON.stringify({
      version: 1, preset: 'deepseek', endpoint: ONLINE_SUMMARY_PRESETS.deepseek.endpoint,
      confirmedHost: 'api.deepseek.com', chatModel: 'deepseek-chat', transcriptionModel: '',
      contextWindow: 128_000, secretRef: 'session:online-openai-compatible',
    }), 'utf8');
    const service = new OnlineAIService(
      new OnlineAIConfigStore(configPath), secrets, fetch,
      () => Promise.reject(new Error('not used')),
    );

    expect(await service.settings()).toMatchObject({
      preset: 'deepseek', keyAvailable: true, keyPersisted: true,
      keyAvailablePresets: ['deepseek'], keyPersistedPresets: ['deepseek'],
    });
    expect(secrets.get('session:online-openai-compatible')).toBeUndefined();
    expect(secrets.get('online-ai:deepseek')).toBe('legacy-deepseek-secret');
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

  it('supports OpenRouter model discovery, attribution headers, and unified reasoning controls', async () => {
    expect(ONLINE_SUMMARY_PRESETS.openrouter.model).toBe('openrouter/free');
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-online-openrouter-'));
    roots.push(root);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      const requestBody = init?.body;
      const streaming = typeof requestBody === 'string'
        && (JSON.parse(requestBody) as { readonly stream?: unknown }).stream === true;
      return Promise.resolve(streaming
        ? new Response([
            'data: {"model":"openrouter/auto","choices":[{"delta":{"content":"sum"},"finish_reason":null}]}',
            '',
            'data: {"choices":[{"delta":{"content":"mary"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":2}}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        : new Response(JSON.stringify({
            data: [{ id: 'openrouter/auto', name: 'Auto Router', context_length: 2_000_000 }],
          }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const service = new OnlineAIService(
      new OnlineAIConfigStore(join(root, 'device', 'online-ai.json')),
      new SessionSecretStore(),
      fetchMock,
      () => Promise.reject(new Error('not used')),
    );

    await expect(service.probe(
      'https://openrouter.ai/api/v1/',
      'openrouter-secret',
      true,
    )).resolves.toEqual([{
      id: 'openrouter/auto', displayName: 'Auto Router', contextWindow: 2_000_000,
    }]);
    const probeInput = fetchMock.mock.calls[0]?.[0];
    if (!(probeInput instanceof URL)) throw new Error('Expected the model endpoint to be a URL.');
    expect(probeInput.href).toBe('https://openrouter.ai/api/v1/models');
    const probeHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(probeHeaders.get('authorization')).toBe('Bearer openrouter-secret');
    expect(probeHeaders.get('http-referer')).toBe('https://github.com/cofftea114/Oldfolio');
    expect(probeHeaders.get('x-openrouter-title')).toBe('Oldfolio');

    await service.configure({
      preset: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1/',
      chatModel: 'openrouter/auto',
      contextWindow: 128_000,
      apiKey: 'openrouter-secret',
      hostConfirmed: true,
    });
    const runtime = await service.runtime();
    await runtime.provider.complete(runtime.config, {
      model: runtime.config.model,
      messages: [{ role: 'user', content: 'fast summary' }],
      reasoningMode: 'disabled',
      responseFormat: 'text',
    }, runtime.context);
    const fastRequestBody = fetchMock.mock.calls[1]?.[1]?.body;
    if (typeof fastRequestBody !== 'string') throw new Error('Expected a JSON request body.');
    expect(JSON.parse(fastRequestBody)).toMatchObject({
      model: 'openrouter/auto', stream: true, reasoning: { effort: 'none' },
    });

    await runtime.provider.complete(runtime.config, {
      model: runtime.config.model,
      messages: [{ role: 'user', content: 'deep summary' }],
      reasoningMode: 'enabled',
      responseFormat: 'text',
    }, runtime.context);
    const deepRequestBody = fetchMock.mock.calls[2]?.[1]?.body;
    if (typeof deepRequestBody !== 'string') throw new Error('Expected a JSON request body.');
    expect(JSON.parse(deepRequestBody)).toMatchObject({
      model: 'openrouter/auto', stream: true, reasoning: { enabled: true },
    });
    await expect(service.transcriptionRuntime('whisper-1')).rejects.toThrow(/不提供.*audio\/transcriptions/u);
  });
});
