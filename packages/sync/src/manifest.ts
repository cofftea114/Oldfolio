import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson, utf8 } from './encoding.js';

export interface ManifestEntry {
  readonly objectId: string;
  readonly revision: string;
  readonly ciphertextHash: string;
  readonly deleted?: boolean;
}

export interface SyncManifestBody {
  readonly version: 1;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly sequence: number;
  readonly previousHash: string | null;
  readonly keyEpoch: number;
  readonly generatedAt: string;
  readonly entries: readonly ManifestEntry[];
}

export interface SyncManifest extends SyncManifestBody {
  readonly hash: string;
}

export class ManifestChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestChainError';
  }
}

export const hashManifestBody = (body: SyncManifestBody): string => bytesToHex(sha256(utf8(canonicalJson(body))));

export function createSyncManifest(input: Omit<SyncManifestBody, 'version'>): SyncManifest {
  if (!input.vaultId.trim() || !input.deviceId.trim()) throw new Error('Manifest vaultId and deviceId are required.');
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new Error('Manifest sequence is invalid.');
  if (!Number.isSafeInteger(input.keyEpoch) || input.keyEpoch < 0) throw new Error('Manifest keyEpoch is invalid.');
  if (input.sequence === 0 && input.previousHash !== null) {
    throw new Error('The first manifest cannot reference a previous hash.');
  }
  if (input.sequence > 0 && !input.previousHash) throw new Error('A non-initial manifest requires previousHash.');
  const body: SyncManifestBody = {
    version: 1,
    ...input,
    entries: [...input.entries].sort((left, right) => left.objectId.localeCompare(right.objectId)),
  };
  return Object.freeze({ ...body, hash: hashManifestBody(body) });
}

export function verifySyncManifest(manifest: SyncManifest, expectedPreviousHash?: string | null): void {
  const { hash, ...body } = manifest;
  if (hashManifestBody(body) !== hash) throw new ManifestChainError('Manifest content hash mismatch.');
  if (expectedPreviousHash !== undefined && manifest.previousHash !== expectedPreviousHash) {
    throw new ManifestChainError('Manifest previous hash does not match the expected chain head.');
  }
}

export function verifyManifestChain(chain: readonly SyncManifest[]): void {
  let previous: string | null = null;
  for (let index = 0; index < chain.length; index += 1) {
    const manifest = chain[index];
    if (!manifest) throw new ManifestChainError('Manifest chain contains an empty entry.');
    verifySyncManifest(manifest, previous);
    if (manifest.sequence !== index) throw new ManifestChainError('Manifest sequence is not contiguous.');
    previous = manifest.hash;
  }
}
