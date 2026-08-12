import type { ISODate, ISODateTime, VaultPath } from './common.js';

export const OKF_VERSION = '0.2' as const;

export type OkfVersion = typeof OKF_VERSION;
export type OkfStatus = 'draft' | 'stable' | 'deprecated';
export type OkfTrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed';

export interface OkfUsageWindow {
  readonly from: ISODate;
  readonly to: ISODate;
  readonly [key: string]: unknown;
}

export interface OkfSource {
  readonly resource: string;
  readonly id?: string | undefined;
  readonly title?: string | undefined;
  readonly author?: string | undefined;
  readonly usage_count?: number | undefined;
  readonly last_modified?: ISODate | undefined;
  readonly usage_window?: OkfUsageWindow | undefined;
  readonly [key: string]: unknown;
}

export interface OkfGenerated {
  readonly by: string;
  readonly at?: ISODateTime | undefined;
  readonly [key: string]: unknown;
}

export interface OkfVerification {
  readonly by: string;
  readonly at: ISODateTime;
  readonly [key: string]: unknown;
}

/** Alias matching the OKF `verified` family name. */
export type OkfVerified = OkfVerification;

export interface OkfParameter {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly [key: string]: unknown;
}

export interface OkfExecutor {
  readonly resource: string;
  readonly receipt?: readonly string[] | undefined;
  readonly [key: string]: unknown;
}

export interface OkfAttester {
  readonly resource: string;
  readonly [key: string]: unknown;
}

export const OLDFOLIO_PROFILE_TYPES = [
  'Source',
  'Transcript',
  'Concept',
  'Creator',
  'Perspective',
  'Audience Insight',
  'Synthesis',
] as const;

export type OldfolioProfileType = (typeof OLDFOLIO_PROFILE_TYPES)[number];

export interface OldfolioMetadata {
  /** Stable logical identity. It remains unchanged when the concept path changes. */
  readonly id: string;
  readonly [key: string]: unknown;
}

/** Canonical, consumer-facing OKF frontmatter. Unknown producer fields are retained. */
export interface OkfConceptFrontmatter {
  readonly type: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly resource?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly sources?: readonly OkfSource[] | undefined;
  readonly usage_window?: OkfUsageWindow | undefined;
  readonly generated?: OkfGenerated | undefined;
  /** Parsers normalize the permitted one-object shorthand to a one-element array. */
  readonly verified?: readonly OkfVerification[] | undefined;
  readonly status?: OkfStatus | undefined;
  readonly stale_after?: ISODate | undefined;
  readonly runtime?: string | undefined;
  readonly parameters?: readonly OkfParameter[] | undefined;
  readonly computation?: string | undefined;
  readonly executor?: OkfExecutor | undefined;
  readonly attester?: OkfAttester | undefined;
  readonly oldfolio?: OldfolioMetadata | undefined;
  readonly [key: string]: unknown;
}

export interface OkfIndexFrontmatter {
  readonly okf_version: string;
  readonly [key: string]: unknown;
}

export interface OkfConcept {
  /** Bundle-relative path without the `.md` suffix. */
  readonly id: string;
  readonly path: VaultPath;
  readonly frontmatter: OkfConceptFrontmatter;
  readonly body: string;
}
