import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CloudTranscriptionConfigStore, CloudTranscriptionService } from './cloud-transcription.js';
import { OnlineAIConfigStore, OnlineAIService, SessionSecretStore } from './online-ai.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('cloud transcription device boundary', () => {
  it('uses a session-only Tencent secret when OS encryption is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-cloud-transcription-'));
    roots.push(root);
    const configPath = join(root, 'cloud-transcription.json');
    const secrets = new SessionSecretStore();
    const online = new OnlineAIService(
      new OnlineAIConfigStore(join(root, 'online-ai.json')),
      secrets,
      fetch,
      () => Promise.reject(new Error('not used')),
    );
    const service = new CloudTranscriptionService(
      new CloudTranscriptionConfigStore(configPath), secrets, online, fetch,
      () => Promise.reject(new Error('not used')),
    );

    const configured = await service.configure({
      providerId: 'tencent-asr', region: 'ap-guangzhou', engineModelType: '16k_zh',
      secretId: 'secret-id', secretKey: 'secret-key',
    });

    expect(configured).toMatchObject({
      providerId: 'tencent-asr', model: '16k_zh', credentialAvailable: true,
      credentialPersisted: false, secureStorageAvailable: false,
      endpointHost: 'asr.tencentcloudapi.com', inputMode: 'chunks',
    });
    const persisted = await readFile(configPath, 'utf8');
    expect(persisted).toContain('session:tencent-asr');
    expect(persisted).not.toContain('secret-id');
    expect(persisted).not.toContain('secret-key');

    await expect(service.configure({
      providerId: 'tencent-asr', region: 'ap-shanghai', engineModelType: '16k_zh',
      secretId: '', secretKey: '',
    })).resolves.toMatchObject({ model: '16k_zh', credentialAvailable: true });

    await expect(service.configure({
      providerId: 'tencent-asr', region: 'ap-shanghai', engineModelType: 'unknown-engine',
      secretId: '', secretKey: '',
    })).rejects.toThrow(/引擎模型/u);
  });

  it('migrates a removed Tingwu configuration to the default provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-cloud-transcription-legacy-'));
    roots.push(root);
    const configPath = join(root, 'cloud-transcription.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      providerId: 'aliyun-tingwu',
      model: 'auto',
      region: 'cn-beijing',
      secretRef: 'session:aliyun-tingwu',
    }));

    const store = new CloudTranscriptionConfigStore(configPath);
    await expect(store.load()).resolves.toEqual({
      version: 1,
      providerId: 'openai-compatible',
      model: 'gpt-4o-mini-transcribe',
      region: '',
      secretRef: 'session:online-openai-compatible',
    });
    await expect(readFile(configPath, 'utf8')).resolves.not.toContain('aliyun-tingwu');
  });

  it('migrates an unsupported saved Tencent engine to the free-package default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-cloud-transcription-engine-'));
    roots.push(root);
    const configPath = join(root, 'cloud-transcription.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      providerId: 'tencent-asr',
      model: 'retired-engine',
      region: 'ap-guangzhou',
      secretRef: 'session:tencent-asr',
    }));

    const store = new CloudTranscriptionConfigStore(configPath);
    await expect(store.load()).resolves.toMatchObject({ providerId: 'tencent-asr', model: '16k_zh' });
    await expect(readFile(configPath, 'utf8')).resolves.toContain('"model": "16k_zh"');
  });
});
