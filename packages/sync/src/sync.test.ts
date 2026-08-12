import { describe, expect, it } from 'vitest';
import {
  ChecksummedRecoveryPhraseCodec,
  ManifestChainError,
  SyncConfigError,
  SyncIntegrityError,
  VaultMasterKey,
  assertSingleSyncMode,
  createSyncManifest,
  decryptSyncObject,
  encryptSyncObject,
  validateSyncConfig,
  verifyManifestChain,
  webDavErrorFromStatus,
  WebDavPreconditionFailedError,
} from './index.js';

describe('sync mode configuration', () => {
  it('accepts exactly one mode and rejects cross-mode fields', () => {
    expect(validateSyncConfig({ mode: 'none' })).toEqual({ mode: 'none' });
    expect(() => validateSyncConfig({ mode: 'webdav_e2ee', endpoint: 'https://dav.example.test', remotePath: '/vault', secretRef: 'dav', directory: 'C:/Vault' })).toThrow(SyncConfigError);
    expect(() => assertSingleSyncMode([{ mode: 'none' }, { mode: 'folder_compat', directory: 'C:/Vault' }])).toThrow(/Exactly one/);
  });

  it('stores only a keychain reference in WebDAV config', () => {
    const config = validateSyncConfig({
      mode: 'webdav_e2ee',
      endpoint: 'https://dav.example.test/root',
      remotePath: '/oldfolio',
      username: 'me',
      secretRef: 'keychain:webdav-main',
    });
    expect(JSON.stringify(config)).not.toContain('password');
    expect(() =>
      validateSyncConfig({
        mode: 'webdav_e2ee',
        endpoint: 'https://me:secret@dav.example.test',
        remotePath: '/oldfolio',
        secretRef: 'keychain:webdav-main',
      }),
    ).toThrow(/credentials/);
  });
});

describe('vault encryption', () => {
  it('round-trips encrypted objects and rejects ciphertext tampering', () => {
    const key = VaultMasterKey.generate();
    expect(JSON.stringify({ key })).not.toContain('Uint8Array');
    const encrypted = encryptSyncObject(new TextEncoder().encode('private note'), key, {
      objectId: 'notes/private.md',
      keyEpoch: 1,
      contentType: 'text/markdown',
    });
    expect(new TextDecoder().decode(decryptSyncObject(encrypted, key))).toBe('private note');

    const last = encrypted.ciphertext.at(-1);
    const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -1)}${last === 'A' ? 'B' : 'A'}` };
    expect(() => decryptSyncObject(tampered, key)).toThrow(SyncIntegrityError);
  });

  it('exports and imports a checksummed offline recovery phrase', () => {
    const codec = new ChecksummedRecoveryPhraseCodec();
    const key = VaultMasterKey.generate();
    const phrase = codec.encode(key);
    expect(codec.decode(phrase).equals(key)).toBe(true);
    expect(() => codec.decode(`${phrase.slice(0, -1)}0`)).toThrow(/checksum/);
  });
});

describe('manifest and WebDAV concurrency primitives', () => {
  it('verifies a manifest hash chain and detects mutation', () => {
    const first = createSyncManifest({
      vaultId: 'vault', deviceId: 'device', sequence: 0, previousHash: null, keyEpoch: 0,
      generatedAt: '2026-08-12T00:00:00Z', entries: [],
    });
    const second = createSyncManifest({
      vaultId: 'vault', deviceId: 'device', sequence: 1, previousHash: first.hash, keyEpoch: 0,
      generatedAt: '2026-08-12T00:01:00Z', entries: [],
    });
    expect(() => verifyManifestChain([first, second])).not.toThrow();
    expect(() => verifyManifestChain([first, { ...second, deviceId: 'attacker' }])).toThrow(ManifestChainError);
  });

  it('models If-Match failures as merge-required errors', () => {
    const error = webDavErrorFromStatus(412, '/manifest.json', '"etag-1"');
    expect(error).toBeInstanceOf(WebDavPreconditionFailedError);
    expect(error.code).toBe('precondition-failed');
  });
});
