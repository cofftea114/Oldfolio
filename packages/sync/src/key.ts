import { sha256 } from '@noble/hashes/sha2.js';
import { equalBytes } from '@noble/ciphers/utils.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { base64UrlToBytes, bytesToBase64Url, utf8 } from './encoding.js';

const MASTER_KEY_BYTES = 32;

export class VaultMasterKey {
  readonly #bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    if (bytes.length !== MASTER_KEY_BYTES) throw new Error('A vault master key must be exactly 32 bytes.');
    this.#bytes = Uint8Array.from(bytes);
    Object.freeze(this);
  }

  static generate(): VaultMasterKey {
    return new VaultMasterKey(randomBytes(MASTER_KEY_BYTES));
  }

  static import(bytes: Uint8Array): VaultMasterKey {
    return new VaultMasterKey(bytes);
  }

  /** The temporary copy is zeroed after the synchronous callback returns. */
  use<T>(consumer: (bytes: Uint8Array) => T): T {
    const temporary = Uint8Array.from(this.#bytes);
    try {
      return consumer(temporary);
    } finally {
      temporary.fill(0);
    }
  }

  equals(other: VaultMasterKey): boolean {
    return this.use((left) => other.use((right) => equalBytes(left, right)));
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  toString(): string {
    return '[REDACTED]';
  }
}

export interface RecoveryPhraseCodec {
  encode(key: VaultMasterKey): string;
  decode(phrase: string): VaultMasterKey;
}

/**
 * Offline, checksummed recovery representation. This is intentionally called a
 * phrase rather than a password: it directly carries random key material and
 * must be stored with the same care as the vault master key.
 */
export class ChecksummedRecoveryPhraseCodec implements RecoveryPhraseCodec {
  encode(key: VaultMasterKey): string {
    return key.use((bytes) => {
      const payload = bytesToBase64Url(bytes);
      const groups = payload.match(/.{1,4}/gu) ?? [];
      const checksum = bytesToHex(sha256(utf8(`oldfolio-v1:${payload}`))).slice(0, 10);
      return ['oldfolio-v1', ...groups, checksum].join(' ');
    });
  }

  decode(phrase: string): VaultMasterKey {
    const groups = phrase.trim().split(/\s+/u);
    if (groups[0] !== 'oldfolio-v1' || groups.length < 3) throw new Error('Invalid recovery phrase format.');
    const checksum = groups.at(-1);
    const payload = groups.slice(1, -1).join('');
    if (!checksum) throw new Error('Invalid recovery phrase checksum.');
    const expected = bytesToHex(sha256(utf8(`oldfolio-v1:${payload}`))).slice(0, 10);
    if (checksum.toLowerCase() !== expected) throw new Error('Recovery phrase checksum mismatch.');
    const bytes = base64UrlToBytes(payload);
    if (bytes.length !== MASTER_KEY_BYTES) throw new Error('Recovery phrase contains an invalid key length.');
    return VaultMasterKey.import(bytes);
  }
}

export const defaultRecoveryPhraseCodec: RecoveryPhraseCodec = new ChecksummedRecoveryPhraseCodec();
