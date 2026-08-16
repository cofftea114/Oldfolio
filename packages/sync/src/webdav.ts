export interface WebDavObjectMetadata {
  readonly path: string;
  readonly etag: string;
  readonly size: number;
  readonly lastModified?: string;
}

export interface WebDavObject extends WebDavObjectMetadata {
  readonly body: Uint8Array;
}

export interface WebDavWriteCondition {
  /** Update only the exact revision previously read. */
  readonly ifMatch?: string;
  /** Use "*" to require creation of a new object. */
  readonly ifNoneMatch?: '*';
}

export interface WebDavTransport {
  head(path: string, signal?: AbortSignal): Promise<WebDavObjectMetadata | null>;
  get(path: string, signal?: AbortSignal): Promise<WebDavObject | null>;
  put(
    path: string,
    body: Uint8Array,
    condition: WebDavWriteCondition,
    signal?: AbortSignal,
  ): Promise<WebDavObjectMetadata>;
  delete(path: string, condition: Pick<WebDavWriteCondition, 'ifMatch'>, signal?: AbortSignal): Promise<void>;
  list(path: string, signal?: AbortSignal): Promise<readonly WebDavObjectMetadata[]>;
}

export type WebDavErrorCode =
  | 'unauthorized'
  | 'not-found'
  | 'precondition-failed'
  | 'conflict'
  | 'network'
  | 'protocol';

export class WebDavTransportError extends Error {
  constructor(
    message: string,
    readonly code: WebDavErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WebDavTransportError';
  }
}

export class WebDavPreconditionFailedError extends WebDavTransportError {
  constructor(
    readonly path: string,
    readonly expectedEtag?: string,
    readonly actualEtag?: string,
  ) {
    super(`The WebDAV object "${path}" changed since it was read. Pull and merge before retrying.`, 'precondition-failed', 412);
    this.name = 'WebDavPreconditionFailedError';
  }
}

/** Maps transport status codes without exposing response bodies or credentials. */
export function webDavErrorFromStatus(status: number, path: string, expectedEtag?: string): WebDavTransportError {
  if (status === 401 || status === 403) return new WebDavTransportError('WebDAV authorization failed.', 'unauthorized', status);
  if (status === 404) return new WebDavTransportError(`WebDAV object "${path}" was not found.`, 'not-found', status);
  if (status === 409) return new WebDavTransportError(`WebDAV conflict at "${path}".`, 'conflict', status);
  if (status === 412) return new WebDavPreconditionFailedError(path, expectedEtag);
  return new WebDavTransportError(`Unexpected WebDAV response status ${status}.`, 'protocol', status);
}
