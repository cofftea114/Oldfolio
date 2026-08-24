import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DeviceSecretStore, type SecretEncryption } from './device-secret-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class TestEncryption implements SecretEncryption {
  constructor(private readonly available = true) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  encrypt(plainText: string): Promise<Buffer> {
    return Promise.resolve(Buffer.from(`protected:${plainText}`, 'utf8'));
  }

  decrypt(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
    const source = encrypted.toString('utf8');
    if (!source.startsWith('protected:')) return Promise.reject(new Error('invalid ciphertext'));
    return Promise.resolve({ result: source.slice('protected:'.length), shouldReEncrypt: false });
  }
}

describe('device secret store', () => {
  it('persists only encrypted bytes and restores a credential after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-device-secrets-'));
    roots.push(root);
    const filePath = join(root, 'device', 'credentials.json');
    const first = new DeviceSecretStore(filePath, new TestEncryption());
    await first.initialize();
    await expect(first.persist('session:online-openai-compatible', 'sk-private-value')).resolves.toBe(true);
    expect(first.isPersisted('session:online-openai-compatible')).toBe(true);
    const persisted = await readFile(filePath, 'utf8');
    expect(persisted).not.toContain('sk-private-value');

    const restarted = new DeviceSecretStore(filePath, new TestEncryption());
    await restarted.initialize();
    expect(restarted.get('session:online-openai-compatible')).toBe('sk-private-value');
    expect(restarted.isPersisted('session:online-openai-compatible')).toBe(true);
  });

  it('removes a saved credential without affecting other encrypted entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-device-secrets-remove-'));
    roots.push(root);
    const filePath = join(root, 'device', 'credentials.json');
    const store = new DeviceSecretStore(filePath, new TestEncryption());
    await store.initialize();
    await store.persist('session:online-openai-compatible', 'online-secret');
    await store.persist('session:tencent-asr', 'tencent-secret');
    await store.remove('session:online-openai-compatible');

    const restarted = new DeviceSecretStore(filePath, new TestEncryption());
    await restarted.initialize();
    expect(restarted.get('session:online-openai-compatible')).toBeUndefined();
    expect(restarted.get('session:tencent-asr')).toBe('tencent-secret');
  });

  it('falls back to memory without writing plaintext when OS encryption is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-device-secrets-session-'));
    roots.push(root);
    const filePath = join(root, 'device', 'credentials.json');
    const store = new DeviceSecretStore(filePath, new TestEncryption(false));
    await store.initialize();
    await expect(store.persist('session:online-openai-compatible', 'session-secret')).resolves.toBe(false);
    expect(store.persistenceAvailable).toBe(false);
    expect(store.get('session:online-openai-compatible')).toBe('session-secret');
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
