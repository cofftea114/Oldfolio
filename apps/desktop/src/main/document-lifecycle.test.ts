import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VaultNotFoundError, VaultRepository } from '@oldfolio/vault';
import { afterEach, describe, expect, it } from 'vitest';

import { DocumentLifecycleService } from './document-lifecycle.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop document lifecycle', () => {
  it('creates native Markdown notes with safe, unique paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-document-lifecycle-'));
    roots.push(root);
    const vault = await VaultRepository.open(join(root, 'vault'));
    await vault.initialize();
    const lifecycle = new DocumentLifecycleService(vault);

    const first = await lifecycle.create('  研究 / 想法  ');
    const second = await lifecycle.create('研究 / 想法');

    expect(first.path).toBe('notes/研究 想法.md');
    expect(first.text).toBe('# 研究 / 想法\n\n');
    expect(second.path).toBe('notes/研究 想法 2.md');
    vault.close();
  });

  it('deletes a visible note through revision history and restores it atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-document-delete-'));
    roots.push(root);
    const vault = await VaultRepository.open(join(root, 'vault'));
    await vault.initialize();
    const lifecycle = new DocumentLifecycleService(vault);
    const note = await lifecycle.create('可恢复笔记');

    const deletion = await lifecycle.delete(note.path, note.revision);
    await expect(vault.read(note.path)).rejects.toBeInstanceOf(VaultNotFoundError);

    const restored = await lifecycle.undoDelete(deletion.historyId);
    expect(restored.path).toBe(note.path);
    await expect(vault.read(note.path)).resolves.toMatchObject({ text: '# 可恢复笔记\n\n' });
    await expect(lifecycle.undoDelete(deletion.historyId)).rejects.toThrow(/无法从当前会话撤销/u);
    vault.close();
  });

  it('refuses to delete reserved bundle documents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-document-internal-'));
    roots.push(root);
    const vault = await VaultRepository.open(join(root, 'vault'));
    await vault.initialize();
    const lifecycle = new DocumentLifecycleService(vault);
    const internal = await vault.read('bundles/personal/index.md');

    await expect(lifecycle.delete(internal.path, internal.revision)).rejects.toThrow(/内部文档不能/u);
    vault.close();
  });
});

