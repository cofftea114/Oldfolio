import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

import type { InstalledLocalModel } from './device-config.js';

export interface ImportLocalModelInput {
  readonly sourcePath: string;
  readonly modelDirectory: string;
  readonly id: string;
  readonly license: string;
  readonly sourceUrl: string;
  readonly licenseAccepted: boolean;
  readonly expectedSha256?: string;
  readonly now?: () => Date;
}

function safeModelId(value: string): string {
  return value.normalize('NFC').trim().replaceAll(/[^a-zA-Z0-9._-]/gu, '-').replaceAll(/-+/gu, '-').slice(0, 80);
}

/** Imports a user-approved model with bounded memory and an atomic final rename. */
export async function importLocalModel(input: ImportLocalModelInput): Promise<InstalledLocalModel> {
  const id = safeModelId(input.id);
  if (!id) throw new Error('Model id is required.');
  if (!input.licenseAccepted || !input.license.trim()) throw new Error('Model license must be explicitly accepted.');
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(input.sourceUrl);
  } catch {
    throw new Error('Model provenance must be an absolute URL.');
  }
  if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password) {
    throw new Error('Model provenance must be an HTTPS URL without credentials.');
  }
  if (input.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/iu.test(input.expectedSha256)) {
    throw new Error('Expected model SHA-256 must contain 64 hexadecimal characters.');
  }
  const stat = await lstat(input.sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error('Model source must be a non-empty regular file.');
  await mkdir(input.modelDirectory, { recursive: true });
  const temporary = join(input.modelDirectory, `.${id}.${randomUUID()}.tmp`);
  const hash = createHash('sha256');
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(input.sourcePath), hasher, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    const sha256 = hash.digest('hex');
    if (input.expectedSha256 && sha256 !== input.expectedSha256.toLowerCase()) throw new Error('Imported model SHA-256 does not match the trusted manifest.');
    const target = join(input.modelDirectory, `${id}-${sha256.slice(0, 16)}.bin`);
    try {
      await rename(temporary, target);
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      await rm(temporary, { force: true });
    }
    const timestamp = (input.now ?? (() => new Date()))().toISOString();
    return {
      id,
      filePath: target,
      sha256,
      license: input.license.trim(),
      sourceUrl: sourceUrl.toString(),
      byteLength: stat.size,
      importedAt: timestamp,
      licenseAcceptedAt: timestamp,
    };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
