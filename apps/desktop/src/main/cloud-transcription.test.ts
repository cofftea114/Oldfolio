import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  it('persists only the provider configuration and session secret reference', async () => {
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
      providerId: 'aliyun-tingwu', region: 'cn-beijing', sourceLanguage: 'auto',
      accessKeyId: 'access-id', accessKeySecret: 'access-secret', appKey: 'app-key',
    });

    expect(configured).toMatchObject({
      providerId: 'aliyun-tingwu', model: 'auto', credentialAvailable: true,
      endpointHost: 'tingwu.cn-beijing.aliyuncs.com', inputMode: 'remote-url',
    });
    const persisted = await readFile(configPath, 'utf8');
    expect(persisted).toContain('session:aliyun-tingwu');
    expect(persisted).not.toContain('access-id');
    expect(persisted).not.toContain('access-secret');
    expect(persisted).not.toContain('app-key');

    await expect(service.configure({
      providerId: 'aliyun-tingwu', region: 'cn-beijing', sourceLanguage: 'cn',
      accessKeyId: '', accessKeySecret: '', appKey: '',
    })).resolves.toMatchObject({ model: 'cn', credentialAvailable: true });
  });
});
