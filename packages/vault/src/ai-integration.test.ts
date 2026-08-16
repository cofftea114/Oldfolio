import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWikiChangeSet } from '@oldfolio/ai';
import { VaultRepository } from './repository.js';

const roots: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AI to vault integration', () => {
  it('applies a shared revision-bound change set and can undo it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-ai-vault-'));
    roots.push(root);
    const vault = await VaultRepository.open(root);
    await vault.initialize();
    const initial = '# Topic\n\nOld claim.\n';
    const updated = '# Topic\n\nNew cited claim.[^source]\n';
    const snapshot = await vault.write('bundles/personal/wiki/topic.md', initial, null);
    const baseRevision = {
      path: snapshot.path,
      revisionId: snapshot.revision,
      contentHash: snapshot.revision,
      modifiedAt: snapshot.modifiedAt.toISOString(),
      byteLength: snapshot.size,
    };
    const changeSet = await createWikiChangeSet({
      baseRevisions: [baseRevision],
      sourceHashes: { source: hash('source') },
      generator: { providerId: 'ollama', model: 'test', promptVersion: '1' },
      riskLevel: 'L2',
      items: [
        {
          id: 'replace-topic',
          summary: 'Replace the compiled claim',
          riskLevel: 'L2',
          operation: {
            kind: 'update',
            path: snapshot.path,
            baseRevision,
            content: updated,
            contentHash: hash(updated),
          },
          diff: '-Old claim.\n+New cited claim.[^source]',
          citationIds: ['source'],
        },
      ],
      citations: [{ id: 'source', sourceId: 'source', resource: 'raw/source.md' }],
    });

    const applied = await vault.applyChangeSet(changeSet);
    expect(await readFile(join(root, snapshot.path), 'utf8')).toBe(updated);
    await vault.undo(applied.historyId);
    expect(await readFile(join(root, snapshot.path), 'utf8')).toBe(initial);
    vault.close();
  });
});
