import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { UnsafeVaultPathError, VaultSymlinkError } from './errors.js';

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export function normalizeVaultPath(input: string): string {
  if (input.length === 0 || input.includes('\0')) {
    throw new UnsafeVaultPathError('Vault path must be a non-empty relative path');
  }

  const portable = input.replaceAll('\\', '/');
  if (
    portable.startsWith('/') ||
    /^[A-Za-z]:/.test(portable) ||
    portable.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new UnsafeVaultPathError(`Unsafe vault path: ${input}`);
  }

  const normalized = path.posix.normalize(portable);
  if (normalized === '.' || normalized.startsWith('../')) {
    throw new UnsafeVaultPathError(`Unsafe vault path: ${input}`);
  }
  return normalized;
}

export class VaultPathResolver {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string): Promise<VaultPathResolver> {
    const absolute = path.resolve(root);
    await mkdir(absolute, { recursive: true });
    const rootStat = await lstat(absolute);
    if (rootStat.isSymbolicLink()) {
      throw new VaultSymlinkError(`Vault root may not be a symbolic link: ${absolute}`);
    }
    return new VaultPathResolver(await realpath(absolute));
  }

  resolve(relativePath: string): { relativePath: string; absolutePath: string } {
    const normalized = normalizeVaultPath(relativePath);
    const absolutePath = path.resolve(this.root, ...normalized.split('/'));
    const relative = path.relative(this.root, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new UnsafeVaultPathError(`Path escapes vault root: ${relativePath}`);
    }
    return { relativePath: normalized, absolutePath };
  }

  async assertNoSymlinks(relativePath: string, includeLeaf = true): Promise<void> {
    const { relativePath: normalized } = this.resolve(relativePath);
    const segments = normalized.split('/');
    const limit = includeLeaf ? segments.length : Math.max(0, segments.length - 1);
    let cursor = this.root;
    for (let index = 0; index < limit; index += 1) {
      const segment = segments[index];
      if (segment === undefined) continue;
      cursor = path.join(cursor, segment);
      try {
        const stat = await lstat(cursor);
        if (stat.isSymbolicLink()) {
          throw new VaultSymlinkError(
            `Symbolic links are not allowed in a vault path: ${normalized}`,
          );
        }
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
    }
  }
}
