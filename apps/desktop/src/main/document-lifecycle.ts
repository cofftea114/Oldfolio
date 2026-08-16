import { createWikiChangeSet } from '@oldfolio/ai';
import type { DocumentRevision } from '@oldfolio/domain';
import {
  VaultNotFoundError,
  type AppliedChangeSet,
  type UndoResult,
  type VaultFileSnapshot,
  type VaultRepository,
} from '@oldfolio/vault';

import { isDocumentManageable } from './document-presentation.js';

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function noteFileName(title: string): string {
  const withoutControls = [...title]
    .map((character) => (character.codePointAt(0) ?? 0) < 32 ? ' ' : character)
    .join('');
  const normalized = withoutControls
    .normalize('NFC')
    .replaceAll(/[<>:"/\\|?*]/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .replaceAll(/[. ]+$/gu, '')
    .trim()
    .slice(0, 80)
    .replaceAll(/[. ]+$/gu, '');
  if (!normalized) throw new Error('笔记标题不能为空。');
  return WINDOWS_RESERVED_NAME.test(normalized) ? `笔记-${normalized}` : normalized;
}

function headingText(title: string): string {
  return title.replaceAll(/\s+/gu, ' ').trim();
}

function documentRevision(snapshot: VaultFileSnapshot): DocumentRevision {
  return {
    path: snapshot.path,
    revisionId: snapshot.revision,
    contentHash: snapshot.revision,
    modifiedAt: snapshot.modifiedAt.toISOString(),
    byteLength: snapshot.size,
  };
}

export class DocumentLifecycleService {
  private readonly deletions = new Map<string, string>();

  constructor(private readonly repository: VaultRepository) {}

  async create(title: string): Promise<VaultFileSnapshot> {
    const displayTitle = headingText(title);
    const fileName = noteFileName(title);
    for (let suffix = 1; suffix <= 9_999; suffix += 1) {
      const candidate = `notes/${fileName}${suffix === 1 ? '' : ` ${suffix}`}.md`;
      try {
        await this.repository.read(candidate);
      } catch (error: unknown) {
        if (error instanceof VaultNotFoundError) {
          return this.repository.write(candidate, `# ${displayTitle}\n\n`, null);
        }
        throw error;
      }
    }
    throw new Error('同名笔记过多，请换一个标题。');
  }

  async delete(path: string, expectedRevision: string): Promise<AppliedChangeSet> {
    if (!isDocumentManageable(path)) throw new Error('Oldfolio 内部文档不能从笔记界面删除。');
    const snapshot = await this.repository.read(path);
    if (snapshot.revision !== expectedRevision) throw new Error('笔记已发生变化，请重新打开后再删除。');
    const baseRevision = documentRevision(snapshot);
    const changeSet = await createWikiChangeSet({
      baseRevisions: [baseRevision],
      sourceHashes: { [snapshot.path]: snapshot.revision },
      generator: {
        providerId: 'oldfolio',
        model: 'user-action',
        promptVersion: 'document-delete-v1',
      },
      riskLevel: 'L3',
      items: [{
        id: `delete-${snapshot.revision.slice(0, 16)}`,
        summary: `删除笔记 ${snapshot.path}`,
        riskLevel: 'L3',
        operation: { kind: 'delete', path: snapshot.path, baseRevision },
        diff: snapshot.text.split('\n').map((line) => `-${line}`).join('\n'),
        citationIds: [],
      }],
      citations: [],
    });
    const applied = await this.repository.applyChangeSet(changeSet);
    this.deletions.set(applied.historyId, snapshot.path);
    return applied;
  }

  async undoDelete(historyId: string): Promise<UndoResult & { readonly path: string }> {
    const path = this.deletions.get(historyId);
    if (!path) throw new Error('这次删除已无法从当前会话撤销。');
    const result = await this.repository.undo(historyId);
    this.deletions.delete(historyId);
    return { ...result, path };
  }
}
