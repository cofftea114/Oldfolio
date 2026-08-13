import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const bundlePath = resolve(import.meta.dirname, '../out/main/index.js');
const bundle = await readFile(bundlePath, 'utf8');
const unresolvedWorkspaceImports = [
  ...bundle.matchAll(/(?:from\s+|import\s*\()\s*["'](@oldfolio\/[^"']+)["']/gu),
].map((match) => match[1]);

if (unresolvedWorkspaceImports.length > 0) {
  throw new Error(
    `Desktop main bundle contains unresolved workspace imports: ${[...new Set(unresolvedWorkspaceImports)].join(', ')}`,
  );
}

console.log('Desktop main bundle contains no unresolved @oldfolio workspace imports.');
