import type { YouTubeChannelSummary, YouTubeDataApiConnector } from '@oldfolio/ingest';
import type { SourceInvocationContext, SourceSnapshot } from '@oldfolio/domain';

import type { SecretStore } from './device-secret-store.js';

const YOUTUBE_SECRET_REF = 'youtube:data-api';

export interface YouTubeCreatorApiSettings {
  readonly endpointHost: 'www.googleapis.com';
  readonly keyAvailable: boolean;
  readonly keyPersisted: boolean;
  readonly maxHistoryEntries: 2_000;
}

export class YouTubeCreatorApiService {
  constructor(
    private readonly connector: YouTubeDataApiConnector,
    private readonly secrets: SecretStore,
  ) {}

  settings(): YouTubeCreatorApiSettings {
    return {
      endpointHost: 'www.googleapis.com',
      keyAvailable: Boolean(this.secrets.get(YOUTUBE_SECRET_REF)),
      keyPersisted: this.secrets.isPersisted(YOUTUBE_SECRET_REF),
      maxHistoryEntries: 2_000,
    };
  }

  async configure(apiKey: string): Promise<YouTubeCreatorApiSettings> {
    const value = apiKey.trim();
    if (!value && !this.secrets.get(YOUTUBE_SECRET_REF)) throw new Error('请填写 YouTube Data API Key。');
    if (value) await this.secrets.persist(YOUTUBE_SECRET_REF, value);
    return this.settings();
  }

  async clear(): Promise<YouTubeCreatorApiSettings> {
    await this.secrets.remove(YOUTUBE_SECRET_REF);
    return this.settings();
  }

  resolveChannel(url: string, signal?: AbortSignal): Promise<YouTubeChannelSummary> {
    return this.connector.resolveChannel(
      { kind: 'url', url },
      YOUTUBE_SECRET_REF,
      this.context(signal),
    );
  }

  fetchHistory(url: string, signal?: AbortSignal): Promise<SourceSnapshot> {
    return this.connector.fetch({
      input: { kind: 'url', url },
      capabilities: ['metadata', 'content', 'subscription'],
      secretRef: YOUTUBE_SECRET_REF,
    }, this.context(signal));
  }

  private context(signal?: AbortSignal): SourceInvocationContext {
    return {
      resolveSecret: (reference) => Promise.resolve(this.secrets.get(reference)),
      ...(signal ? { signal } : {}),
    };
  }
}
