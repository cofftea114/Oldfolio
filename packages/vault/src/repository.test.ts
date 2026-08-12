import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { WikiChangeSet } from '@oldfolio/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VaultConflictError, VaultRepository, VaultSymlinkError } from './index.js';

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('VaultRepository', () => {
  let root: string;
  let vault: VaultRepository;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oldfolio-vault-'));
    vault = await VaultRepository.open(root);
  });

  afterEach(async () => {
    vault.close();
    await rm(root, { recursive: true, force: true });
  });

  it('initializes the local-first vault layout', async () => {
    await vault.initialize();
    for (const directory of [
      'notes',
      'assets',
      'bundles/personal/raw',
      'bundles/personal/wiki',
      'bundles/creators',
      'bundles/synthesis/wiki',
      '.oldfolio/schema',
      '.oldfolio/config',
      '.oldfolio/history',
      '.oldfolio/cache',
    ]) {
      expect((await lstat(path.join(root, ...directory.split('/')))).isDirectory()).toBe(true);
    }
    expect(await readFile(path.join(root, 'bundles', 'personal', 'index.md'), 'utf8')).toContain(
      'okf_version: "0.2"',
    );
  });

  it('scans Markdown without rewriting a byte', async () => {
    await vault.initialize();
    const original = Buffer.from('\uFEFF# 标题\r\n\r\n保留  spaces  \r\n', 'utf8');
    const file = path.join(root, 'notes', '原样.md');
    await writeFile(file, original);

    const scanned = await vault.scanDocuments();

    const snapshot = scanned.find((entry) => entry.path === 'notes/原样.md');
    expect(snapshot).toBeDefined();
    expect(Buffer.from(snapshot?.bytes ?? []).equals(original)).toBe(true);
    expect((await readFile(file)).equals(original)).toBe(true);
  });

  it('rejects traversal and symbolic links', async () => {
    await vault.initialize();
    await expect(vault.read('../outside.md')).rejects.toThrow('Unsafe vault path');
    const target = path.join(root, 'notes', 'target.md');
    const link = path.join(root, 'notes', 'linked.md');
    await writeFile(target, '# target');
    try {
      await symlink(target, link, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await expect(vault.scanDocuments()).rejects.toBeInstanceOf(VaultSymlinkError);
  });

  it('uses revisions to reject stale and accidental overwrite writes', async () => {
    await vault.initialize();
    const created = await vault.write('notes/conflict.md', 'one', null);
    await expect(vault.write('notes/conflict.md', 'again', null)).rejects.toBeInstanceOf(
      VaultConflictError,
    );
    const updated = await vault.write('notes/conflict.md', 'two', created.revision);
    await expect(vault.write('notes/conflict.md', 'stale', created.revision)).rejects.toMatchObject(
      {
        actualRevision: updated.revision,
      },
    );
  });

  it('rebuilds search and link graph entirely from Markdown files', async () => {
    await vault.initialize();
    await vault.write(
      'notes/alpha.md',
      '# Alpha\n\nLinks to [[Beta#Details|the answer]] and #topic.',
      null,
    );
    await vault.write('notes/beta.md', '# Beta\n\n## Details\n\n独特中文知识。', null);

    expect(await vault.rebuildIndex()).toMatchObject({ documents: 6, links: 1, tags: 1 });
    expect((await vault.search('Alpha'))[0]?.path).toBe('notes/alpha.md');
    expect((await vault.search('中文'))[0]?.path).toBe('notes/beta.md');
    expect(await vault.backlinks('notes/beta.md')).toEqual([
      expect.objectContaining({
        sourcePath: 'notes/alpha.md',
        anchor: 'Details',
        label: 'the answer',
      }),
    ]);

    vault.close();
    await rm(path.join(root, '.oldfolio', 'cache'), { recursive: true, force: true });
    vault = await VaultRepository.open(root);
    await vault.initialize();
    expect((await vault.rebuildIndex()).documents).toBe(6);
    expect((await vault.search('知识'))[0]?.path).toBe('notes/beta.md');
  });

  it('applies a revision-bound change set and can undo it', async () => {
    await vault.initialize();
    const original = await vault.write('notes/existing.md', 'before', null);
    const updatedContent = 'after';
    const createdContent = '# New';
    const changeSet = {
      id: 'change-1',
      createdAt: new Date().toISOString(),
      baseRevisions: [
        {
          path: 'notes/existing.md',
          revisionId: original.revision,
          contentHash: original.revision,
          modifiedAt: original.modifiedAt.toISOString(),
          byteLength: original.size,
        },
      ],
      sourceHashes: {},
      generator: { providerId: 'test', model: 'test', promptVersion: '1' },
      riskLevel: 'L2',
      items: [
        {
          id: 'item-1',
          summary: 'update',
          riskLevel: 'L2',
          operation: {
            kind: 'update',
            path: 'notes/existing.md',
            baseRevision: {
              path: 'notes/existing.md',
              revisionId: original.revision,
              contentHash: original.revision,
              modifiedAt: original.modifiedAt.toISOString(),
              byteLength: original.size,
            },
            content: updatedContent,
            contentHash: hash(updatedContent),
          },
          diff: '',
          citationIds: [],
        },
        {
          id: 'item-2',
          summary: 'create',
          riskLevel: 'L1',
          operation: {
            kind: 'create',
            path: 'notes/new.md',
            content: createdContent,
            contentHash: hash(createdContent),
          },
          diff: '',
          citationIds: [],
        },
      ],
      citations: [],
      rollback: { operations: [] },
    } as unknown as WikiChangeSet;

    const applied = await vault.applyChangeSet(changeSet);
    expect((await vault.read('notes/existing.md')).text).toBe('after');
    expect((await vault.read('notes/new.md')).text).toBe('# New');

    await vault.undo(applied.historyId);
    expect((await vault.read('notes/existing.md')).text).toBe('before');
    await expect(vault.read('notes/new.md')).rejects.toThrow('does not exist');
  });

  it('rejects a stale change set without partially changing files', async () => {
    await vault.initialize();
    const current = await vault.write('notes/existing.md', 'current', null);
    const changeSet = {
      id: 'stale',
      baseRevisions: [
        {
          path: 'notes/existing.md',
          revisionId: 'old-revision',
          contentHash: 'old-revision',
          modifiedAt: new Date().toISOString(),
          byteLength: 0,
        },
      ],
      items: [
        {
          operation: {
            kind: 'update',
            path: 'notes/existing.md',
            baseRevision: {
              path: 'notes/existing.md',
              revisionId: 'old-revision',
              contentHash: 'old-revision',
              modifiedAt: new Date().toISOString(),
              byteLength: 0,
            },
            content: 'bad',
            contentHash: hash('bad'),
          },
        },
      ],
    } as unknown as WikiChangeSet;

    await expect(vault.applyChangeSet(changeSet)).rejects.toBeInstanceOf(VaultConflictError);
    expect((await vault.read('notes/existing.md')).revision).toBe(current.revision);
    expect((await vault.read('notes/existing.md')).text).toBe('current');
  });

  it('recovers an interrupted applying journal on the next initialization', async () => {
    await vault.initialize();
    const original = await vault.write('notes/recovery.md', 'safe state', null);
    const record = {
      version: 1,
      id: 'crash-recovery',
      changeSetId: 'interrupted',
      createdAt: new Date().toISOString(),
      before: [
        {
          path: 'notes/recovery.md',
          revision: original.revision,
          content: Buffer.from('safe state').toString('base64'),
        },
      ],
      after: [],
      status: 'applying',
    };
    await vault.write('.oldfolio/history/crash-recovery.json', `${JSON.stringify(record)}\n`, null);
    await vault.write('notes/recovery.md', 'partially applied', original.revision);

    vault.close();
    vault = await VaultRepository.open(root);
    await vault.initialize();

    expect((await vault.read('notes/recovery.md')).text).toBe('safe state');
    expect(
      JSON.parse((await vault.read('.oldfolio/history/crash-recovery.json')).text),
    ).toMatchObject({
      status: 'rolled_back',
    });
  });

  it('prohibits L4 external-side-effect change sets', async () => {
    await vault.initialize();
    const changeSet = {
      id: 'forbidden',
      createdAt: new Date().toISOString(),
      baseRevisions: [],
      sourceHashes: {},
      generator: { providerId: 'test', model: 'test', promptVersion: '1' },
      riskLevel: 'L4',
      items: [],
      citations: [],
      rollback: { operations: [] },
    } satisfies WikiChangeSet;

    await expect(vault.applyChangeSet(changeSet)).rejects.toThrow('L4 change sets are prohibited');
  });
});
