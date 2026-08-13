import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MEDIA_EXTENSIONS = new Set([
  '.aac', '.flac', '.m4a', '.mkv', '.mov', '.mp3', '.mp4', '.mpeg', '.mpg', '.ogg', '.opus', '.wav', '.webm',
]);

export interface ImportedMediaAsset {
  readonly originalName: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly vaultPath: string;
  readonly absolutePath: string;
}

/** Copies a regular media file into the Vault using a content-addressed, atomic path. */
export async function importMediaAsset(
  sourcePath: string,
  vaultRoot: string,
): Promise<ImportedMediaAsset> {
  const stat = await lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error('Media source must be a non-empty regular file.');
  const extension = extname(sourcePath).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension)) throw new Error(`Unsupported local media type: ${extension || '<none>'}`);
  const directory = join(vaultRoot, 'assets', 'media');
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const hash = createHash('sha256');
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(sourcePath), hasher, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    const contentHash = hash.digest('hex');
    const vaultPath = `assets/media/${contentHash}${extension}`;
    const absolutePath = join(vaultRoot, ...vaultPath.split('/'));
    try {
      await rename(temporary, absolutePath);
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      await rm(temporary, { force: true });
    }
    return { originalName: basename(sourcePath), contentHash, byteLength: stat.size, vaultPath, absolutePath };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
