export interface NoSyncConfig {
  readonly mode: 'none';
}

export interface WebDavE2EEConfig {
  readonly mode: 'webdav_e2ee';
  readonly endpoint: string;
  readonly remotePath: string;
  readonly username?: string;
  /** Lookup name for an OS-keychain entry; never the actual password. */
  readonly secretRef: string;
}

export interface FolderCompatConfig {
  readonly mode: 'folder_compat';
  readonly directory: string;
}

export type SyncConfig = NoSyncConfig | WebDavE2EEConfig | FolderCompatConfig;

export class SyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncConfigError';
  }
}

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

const requiredString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SyncConfigError(`Sync configuration field "${key}" must be a non-empty string.`);
  }
  return value;
};

const rejectUnknownKeys = (record: Record<string, unknown>, allowed: readonly string[]): void => {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new SyncConfigError(
      `Sync mode configuration contains incompatible fields: ${unexpected.sort().join(', ')}. Modes are mutually exclusive.`,
    );
  }
};

/** Strict parsing prevents fields from two sync modes being silently combined. */
export function validateSyncConfig(input: unknown): SyncConfig {
  if (!isRecord(input)) throw new SyncConfigError('Sync configuration must be an object.');
  switch (input.mode) {
    case 'none':
      rejectUnknownKeys(input, ['mode']);
      return Object.freeze({ mode: 'none' });
    case 'webdav_e2ee': {
      rejectUnknownKeys(input, ['mode', 'endpoint', 'remotePath', 'username', 'secretRef']);
      const endpoint = requiredString(input, 'endpoint');
      let url: URL;
      try {
        url = new URL(endpoint);
      } catch {
        throw new SyncConfigError('WebDAV endpoint must be an absolute URL.');
      }
      if (url.protocol !== 'https:') throw new SyncConfigError('WebDAV endpoints must use HTTPS.');
      if (url.username || url.password) {
        throw new SyncConfigError('WebDAV credentials must be stored by secret reference, not embedded in the URL.');
      }
      const username = input.username;
      if (username !== undefined && typeof username !== 'string') {
        throw new SyncConfigError('WebDAV username must be a string.');
      }
      return Object.freeze({
        mode: 'webdav_e2ee',
        endpoint: url.href,
        remotePath: requiredString(input, 'remotePath'),
        secretRef: requiredString(input, 'secretRef'),
        ...(username === undefined ? {} : { username }),
      });
    }
    case 'folder_compat':
      rejectUnknownKeys(input, ['mode', 'directory']);
      return Object.freeze({ mode: 'folder_compat', directory: requiredString(input, 'directory') });
    default:
      throw new SyncConfigError('Unknown sync mode. Expected none, webdav_e2ee, or folder_compat.');
  }
}

export function assertSingleSyncMode(configs: readonly SyncConfig[]): SyncConfig {
  if (configs.length !== 1) {
    throw new SyncConfigError('Exactly one sync mode must be configured for a vault.');
  }
  const config = configs[0];
  if (!config) throw new SyncConfigError('Exactly one sync mode must be configured for a vault.');
  return validateSyncConfig(config);
}
