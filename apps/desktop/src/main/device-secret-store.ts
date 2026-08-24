import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface SecretStore {
  readonly persistenceAvailable: boolean;
  setSession(reference: string, secret: string): void;
  persist(reference: string, secret: string): Promise<boolean>;
  get(reference: string): string | undefined;
  deleteSession(reference: string): void;
  remove(reference: string): Promise<void>;
  clearSession(): void;
  isPersisted(reference: string): boolean;
}

export interface SecretEncryption {
  isAvailable(): Promise<boolean>;
  encrypt(plainText: string): Promise<Buffer>;
  decrypt(encrypted: Buffer): Promise<{
    readonly result: string;
    readonly shouldReEncrypt: boolean;
  }>;
}

interface PersistedSecretFile {
  readonly version: 1;
  readonly entries: Readonly<Record<string, string>>;
}

const MAX_SECRET_CHARACTERS = 16_384;
const MAX_ENCRYPTED_BYTES = 128 * 1024;

function normalizeReference(reference: string): string {
  const normalized = reference.trim();
  if (!/^[a-z0-9][a-z0-9:._-]{0,255}$/iu.test(normalized)) throw new Error('密钥引用无效。');
  return normalized;
}

function normalizeSecret(secret: string): string {
  const normalized = secret.trim();
  if (!normalized || normalized.length > MAX_SECRET_CHARACTERS || normalized.includes('\0')) {
    throw new Error('API 凭据无效。');
  }
  return normalized;
}

function decodeEncrypted(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !value || value.length > MAX_ENCRYPTED_BYTES * 2) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength > 0 && decoded.byteLength <= MAX_ENCRYPTED_BYTES ? decoded : undefined;
}

function parseSecretFile(source: string): PersistedSecretFile {
  const value = JSON.parse(source) as unknown;
  if (typeof value !== 'object' || value === null) throw new Error('设备密钥文件无效。');
  const record = value as { readonly version?: unknown; readonly entries?: unknown };
  if (record.version !== 1 || typeof record.entries !== 'object' || record.entries === null || Array.isArray(record.entries)) {
    throw new Error('设备密钥文件无效。');
  }
  const entries: Record<string, string> = {};
  for (const [reference, encrypted] of Object.entries(record.entries)) {
    const normalizedReference = normalizeReference(reference);
    if (!decodeEncrypted(encrypted)) continue;
    entries[normalizedReference] = encrypted as string;
  }
  return { version: 1, entries };
}

export class DeviceSecretStore implements SecretStore {
  readonly #secrets = new Map<string, string>();
  readonly #persisted = new Set<string>();
  readonly #encryptedEntries = new Map<string, string>();
  #persistenceAvailable = false;

  constructor(
    readonly filePath: string,
    private readonly encryption: SecretEncryption,
  ) {}

  get persistenceAvailable(): boolean {
    return this.#persistenceAvailable;
  }

  async initialize(): Promise<void> {
    this.#persistenceAvailable = await this.encryption.isAvailable();
    if (!this.#persistenceAvailable) return;
    let persisted: PersistedSecretFile;
    try {
      persisted = parseSecretFile(await readFile(this.filePath, 'utf8'));
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      return;
    }
    let refreshed = false;
    for (const [reference, encoded] of Object.entries(persisted.entries)) {
      const encrypted = decodeEncrypted(encoded);
      if (!encrypted) continue;
      try {
        const decrypted = await this.encryption.decrypt(encrypted);
        const secret = normalizeSecret(decrypted.result);
        this.#secrets.set(reference, secret);
        this.#persisted.add(reference);
        if (decrypted.shouldReEncrypt) {
          const replacement = await this.encryption.encrypt(secret);
          this.#encryptedEntries.set(reference, replacement.toString('base64'));
          refreshed = true;
        } else {
          this.#encryptedEntries.set(reference, encoded);
        }
      } catch {
        // A credential bound to another OS user or a rotated key is unavailable, but must not block startup.
      }
    }
    if (refreshed) await this.#writeEntries(this.#encryptedEntries);
  }

  setSession(reference: string, secret: string): void {
    this.#secrets.set(normalizeReference(reference), normalizeSecret(secret));
  }

  async persist(reference: string, secret: string): Promise<boolean> {
    const normalizedReference = normalizeReference(reference);
    const normalizedSecret = normalizeSecret(secret);
    if (!this.#persistenceAvailable) {
      this.#secrets.set(normalizedReference, normalizedSecret);
      return false;
    }
    const encrypted = await this.encryption.encrypt(normalizedSecret);
    if (encrypted.byteLength === 0 || encrypted.byteLength > MAX_ENCRYPTED_BYTES) {
      throw new Error('操作系统返回的加密凭据无效。');
    }
    const next = new Map(this.#encryptedEntries);
    next.set(normalizedReference, encrypted.toString('base64'));
    await this.#writeEntries(next);
    this.#encryptedEntries.clear();
    next.forEach((value, key) => this.#encryptedEntries.set(key, value));
    this.#secrets.set(normalizedReference, normalizedSecret);
    this.#persisted.add(normalizedReference);
    return true;
  }

  get(reference: string): string | undefined {
    return this.#secrets.get(normalizeReference(reference));
  }

  deleteSession(reference: string): void {
    this.#secrets.delete(normalizeReference(reference));
  }

  async remove(reference: string): Promise<void> {
    const normalizedReference = normalizeReference(reference);
    if (this.#encryptedEntries.has(normalizedReference)) {
      const next = new Map(this.#encryptedEntries);
      next.delete(normalizedReference);
      await this.#writeEntries(next);
      this.#encryptedEntries.clear();
      next.forEach((value, key) => this.#encryptedEntries.set(key, value));
    }
    this.#secrets.delete(normalizedReference);
    this.#persisted.delete(normalizedReference);
  }

  clearSession(): void {
    this.#secrets.clear();
  }

  isPersisted(reference: string): boolean {
    return this.#persisted.has(normalizeReference(reference));
  }

  async #writeEntries(entries: ReadonlyMap<string, string>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    const serialized: PersistedSecretFile = {
      version: 1,
      entries: Object.fromEntries([...entries.entries()].sort(([left], [right]) => left.localeCompare(right))),
    };
    await writeFile(temporary, `${JSON.stringify(serialized, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}
