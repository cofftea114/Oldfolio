import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { equalBytes, randomBytes } from '@noble/ciphers/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64UrlToBytes, bytesToBase64Url, canonicalJson, utf8 } from './encoding.js';
import type { VaultMasterKey } from './key.js';

export interface EncryptedObjectMetadata {
  readonly objectId: string;
  readonly keyEpoch: number;
  readonly contentType: string;
}

export interface EncryptedSyncObject extends EncryptedObjectMetadata {
  readonly version: 1;
  readonly algorithm: 'xchacha20-poly1305';
  readonly nonce: string;
  readonly ciphertext: string;
  readonly plaintextHash: string;
  readonly aadHash: string;
}

export class SyncIntegrityError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SyncIntegrityError';
  }
}

const validateMetadata = (metadata: EncryptedObjectMetadata): void => {
  if (!metadata.objectId.trim()) throw new Error('Encrypted objectId is required.');
  if (!Number.isSafeInteger(metadata.keyEpoch) || metadata.keyEpoch < 0) {
    throw new Error('Encrypted object keyEpoch must be a non-negative safe integer.');
  }
  if (!metadata.contentType.trim()) throw new Error('Encrypted object contentType is required.');
};

const associatedData = (metadata: EncryptedObjectMetadata): Uint8Array =>
  utf8(
    canonicalJson({
      version: 1,
      algorithm: 'xchacha20-poly1305',
      objectId: metadata.objectId,
      keyEpoch: metadata.keyEpoch,
      contentType: metadata.contentType,
    }),
  );

export function encryptSyncObject(
  plaintext: Uint8Array,
  key: VaultMasterKey,
  metadata: EncryptedObjectMetadata,
): EncryptedSyncObject {
  validateMetadata(metadata);
  const nonce = randomBytes(24);
  const aad = associatedData(metadata);
  const ciphertext = key.use((keyBytes) => xchacha20poly1305(keyBytes, nonce, aad).encrypt(plaintext));
  return Object.freeze({
    version: 1,
    algorithm: 'xchacha20-poly1305',
    ...metadata,
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(ciphertext),
    plaintextHash: bytesToHex(sha256(plaintext)),
    aadHash: bytesToHex(sha256(aad)),
  });
}

export function decryptSyncObject(encrypted: EncryptedSyncObject, key: VaultMasterKey): Uint8Array {
  if (encrypted.version !== 1 || encrypted.algorithm !== 'xchacha20-poly1305') {
    throw new SyncIntegrityError('Unsupported encrypted object format.');
  }
  validateMetadata(encrypted);
  const aad = associatedData(encrypted);
  if (!equalBytes(sha256(aad), hexDigest(encrypted.aadHash))) {
    throw new SyncIntegrityError('Encrypted object metadata was modified.');
  }
  try {
    const nonce = base64UrlToBytes(encrypted.nonce);
    const ciphertext = base64UrlToBytes(encrypted.ciphertext);
    const plaintext = key.use((keyBytes) => xchacha20poly1305(keyBytes, nonce, aad).decrypt(ciphertext));
    if (!equalBytes(sha256(plaintext), hexDigest(encrypted.plaintextHash))) {
      throw new SyncIntegrityError('Encrypted object plaintext hash mismatch.');
    }
    return plaintext;
  } catch (error) {
    if (error instanceof SyncIntegrityError) throw error;
    throw new SyncIntegrityError('Encrypted object authentication failed.', error);
  }
}

const hexDigest = (value: string): Uint8Array => {
  if (!/^[a-f0-9]{64}$/iu.test(value)) throw new SyncIntegrityError('Invalid SHA-256 digest.');
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
};
