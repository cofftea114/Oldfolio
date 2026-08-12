import type { ContentHash, ISODateTime, OperationContext } from './common.js';

export type SourceInput =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly uri: string; readonly mimeType?: string }
  | { readonly kind: 'feed'; readonly url: string };

export type SourceCapability =
  | 'metadata'
  | 'content'
  | 'captions'
  | 'comments'
  | 'subscription';

export type SourceAuthorization = 'none' | 'api_key' | 'oauth' | 'user_import';

/** Only product-approved, documented acquisition routes are representable. */
export type SourceAccessMethod =
  | 'local_file'
  | 'direct_url'
  | 'open_feed'
  | 'official_api'
  | 'user_import';

export interface SourceRetentionPolicy {
  readonly handlesRemoteDeletionSignals: boolean;
  readonly supportsUserErasure: boolean;
  readonly defaultRefreshIntervalMs?: number;
  readonly notes?: string;
}

export interface SourceCapabilityState {
  readonly capability: SourceCapability;
  readonly availability: 'available' | 'authorization_required' | 'unsupported';
  readonly authorization: SourceAuthorization;
  readonly reason?: string;
}

export interface SourceProbeResult {
  readonly matched: boolean;
  readonly canonicalUri?: string;
  readonly capabilities: readonly SourceCapabilityState[];
}

export interface SourceDeletionPolicy {
  readonly supportsRemoteDeletionSignals: boolean;
  readonly refreshAfter?: ISODateTime;
  readonly retainUntil?: ISODateTime;
}

export interface SourceSnapshot {
  readonly id: string;
  readonly connectorId: string;
  readonly canonicalUri: string;
  readonly fetchedAt: ISODateTime;
  readonly contentHash: ContentHash;
  readonly title?: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly deletionPolicy: SourceDeletionPolicy;
}

export interface SourceFetchRequest {
  readonly input: SourceInput;
  readonly capabilities: readonly SourceCapability[];
  /** A keychain reference only. Connectors never receive serialized secrets here. */
  readonly secretRef?: string;
  readonly previous?: SourceSnapshot;
}

export interface SourceConnector {
  readonly id: string;
  readonly displayName: string;
  readonly accessMethods: readonly SourceAccessMethod[];
  readonly retentionPolicy: SourceRetentionPolicy;
  probe(input: SourceInput, context?: OperationContext): Promise<SourceProbeResult>;
  fetch(request: SourceFetchRequest, context?: OperationContext): Promise<SourceSnapshot>;
}
