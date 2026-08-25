import { YouTubeDataApiConnector } from '@oldfolio/ingest';
import { describe, expect, it, vi } from 'vitest';

import type { SecretStore } from './device-secret-store.js';
import { YouTubeCreatorApiService } from './youtube-creator-api.js';

class MemorySecrets implements SecretStore {
  readonly persistenceAvailable = true;
  readonly values = new Map<string, string>();
  readonly persisted = new Set<string>();
  setSession(reference: string, secret: string): void { this.values.set(reference, secret); }
  persist(reference: string, secret: string): Promise<boolean> {
    this.values.set(reference, secret);
    this.persisted.add(reference);
    return Promise.resolve(true);
  }
  get(reference: string): string | undefined { return this.values.get(reference); }
  deleteSession(reference: string): void { this.values.delete(reference); }
  remove(reference: string): Promise<void> {
    this.values.delete(reference);
    this.persisted.delete(reference);
    return Promise.resolve();
  }
  clearSession(): void { this.values.clear(); }
  isPersisted(reference: string): boolean { return this.persisted.has(reference); }
}

describe('YouTube creator API settings', () => {
  it('persists and clears the API key through the device secret store', async () => {
    const secrets = new MemorySecrets();
    const connector = new YouTubeDataApiConnector({ fetcher: vi.fn() });
    const service = new YouTubeCreatorApiService(connector, secrets);
    expect(service.settings()).toMatchObject({ keyAvailable: false, keyPersisted: false, maxHistoryEntries: 2_000 });
    await expect(service.configure('youtube-key')).resolves.toMatchObject({ keyAvailable: true, keyPersisted: true });
    expect(secrets.get('youtube:data-api')).toBe('youtube-key');
    await expect(service.configure('')).resolves.toMatchObject({ keyAvailable: true });
    await expect(service.clear()).resolves.toMatchObject({ keyAvailable: false, keyPersisted: false });
  });

  it('rejects an empty first-time configuration', async () => {
    const service = new YouTubeCreatorApiService(
      new YouTubeDataApiConnector({ fetcher: vi.fn() }),
      new MemorySecrets(),
    );
    await expect(service.configure('')).rejects.toThrow(/请填写/u);
  });
});
