import { parseOkfDocument } from '@oldfolio/okf';
import { VaultNotFoundError, type VaultRepository } from '@oldfolio/vault';

export async function writeConceptOnce(
  repository: VaultRepository,
  path: string,
  content: string,
  stableId: string,
): Promise<boolean> {
  try {
    const existing = await repository.read(path);
    const bundlePath = path.replace(/^bundles\/personal\//u, '');
    const parsed = parseOkfDocument(existing.text, bundlePath);
    const oldfolio = parsed.frontmatter?.oldfolio as { readonly id?: unknown } | undefined;
    if (!parsed.valid || oldfolio?.id !== stableId) {
      throw new Error(`路径 ${path} 已存在，但不是预期的不可变知识对象`);
    }
    return false;
  } catch (error: unknown) {
    if (!(error instanceof VaultNotFoundError)) throw error;
    await repository.write(path, content, null);
    return true;
  }
}
