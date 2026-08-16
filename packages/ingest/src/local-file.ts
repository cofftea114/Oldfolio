import type {
  OperationContext,
  SourceCapability,
  SourceConnector,
  SourceFetchRequest,
  SourceInput,
  SourceProbeResult,
  SourceSnapshot,
} from '@oldfolio/domain';

import { sha256 } from './hash.js';

export interface LocalSourceFile {
  readonly bytes: Uint8Array;
  readonly displayName?: string;
  readonly mimeType?: string;
  readonly modifiedAt?: string;
}

export type LocalSourceReader = (uri: string, signal?: AbortSignal) => Promise<LocalSourceFile>;

export interface LocalFileConnectorOptions {
  readonly read: LocalSourceReader;
  readonly now?: () => Date;
}

const SUPPORTED = new Set<SourceCapability>(['metadata', 'content', 'captions']);

function isTextual(mimeType: string | undefined, uri: string): boolean {
  if (mimeType?.startsWith('text/') === true) return true;
  if (mimeType === 'application/json' || mimeType === 'application/x-subrip') return true;
  return /\.(?:md|markdown|txt|json|csv|srt|vtt)$/iu.test(uri);
}

export class LocalFileSourceConnector implements SourceConnector {
  readonly id = 'org.oldfolio.local-file';
  readonly displayName = 'Local file / user import';
  readonly accessMethods = ['local_file', 'user_import'] as const;
  readonly retentionPolicy = {
    handlesRemoteDeletionSignals: false,
    supportsUserErasure: true,
    notes: 'Imported snapshots are retained until the user erases them.',
  } as const;

  readonly #read: LocalSourceReader;
  readonly #now: () => Date;

  constructor(options: LocalFileConnectorOptions) {
    this.#read = options.read;
    this.#now = options.now ?? (() => new Date());
  }

  probe(input: SourceInput): Promise<SourceProbeResult> {
    if (input.kind !== 'file') return Promise.resolve({ matched: false, capabilities: [] });
    const captions = /\.(?:srt|vtt)$/iu.test(input.uri) || /(?:subrip|vtt)/iu.test(input.mimeType ?? '');
    return Promise.resolve({
      matched: true,
      canonicalUri: input.uri,
      capabilities: [
        { capability: 'metadata', availability: 'available', authorization: 'user_import' },
        { capability: 'content', availability: 'available', authorization: 'user_import' },
        {
          capability: 'captions',
          availability: captions ? 'available' : 'unsupported',
          authorization: 'user_import',
        },
        { capability: 'comments', availability: 'unsupported', authorization: 'user_import' },
        { capability: 'subscription', availability: 'unsupported', authorization: 'user_import' },
      ],
    });
  }

  async fetch(request: SourceFetchRequest, context?: OperationContext): Promise<SourceSnapshot> {
    if (request.input.kind !== 'file') throw new Error('Local file connector requires a file input.');
    for (const capability of request.capabilities) {
      if (!SUPPORTED.has(capability)) throw new Error(`Local file connector does not support ${capability}.`);
    }
    const file = await this.#read(request.input.uri, context?.signal);
    const contentHash = sha256(file.bytes);
    const lineageId = `file-${sha256(request.input.uri).slice(0, 24)}`;
    const mimeType = file.mimeType ?? request.input.mimeType;
    return {
      id: `${lineageId}-${contentHash.slice(0, 16)}`,
      connectorId: this.id,
      canonicalUri: request.input.uri,
      fetchedAt: this.#now().toISOString(),
      contentHash,
      title: file.displayName ?? request.input.uri.split(/[\\/]/u).at(-1) ?? 'Imported file',
      ...(mimeType ? { mimeType } : {}),
      ...(isTextual(mimeType, request.input.uri)
        ? { text: new TextDecoder('utf-8', { fatal: false }).decode(file.bytes) }
        : {}),
      metadata: {
        sourceLineageId: lineageId,
        byteLength: file.bytes.byteLength,
        ...(file.modifiedAt ? { modifiedAt: file.modifiedAt } : {}),
      },
      deletionPolicy: { supportsRemoteDeletionSignals: false },
    };
  }
}
