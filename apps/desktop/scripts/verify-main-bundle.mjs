import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const bundlePath = resolve(import.meta.dirname, '../out/main/index.js');
const bundle = await readFile(bundlePath, 'utf8');
const preloadPath = resolve(import.meta.dirname, '../out/preload/index.cjs');
const preload = await readFile(preloadPath, 'utf8');
const unresolvedWorkspaceImports = [
  ...bundle.matchAll(/(?:from\s+|import\s*\()\s*["'](@oldfolio\/[^"']+)["']/gu),
].map((match) => match[1]);

if (unresolvedWorkspaceImports.length > 0) {
  throw new Error(
    `Desktop main bundle contains unresolved workspace imports: ${[...new Set(unresolvedWorkspaceImports)].join(', ')}`,
  );
}

if (!bundle.includes('preload/index.cjs') || bundle.includes('preload/index.mjs')) {
  throw new Error('Sandboxed renderer must load the CommonJS preload bundle.');
}
if (!preload.includes('contextBridge.exposeInMainWorld')) {
  throw new Error('Preload bundle does not expose the Oldfolio context bridge.');
}

console.log('Desktop bundles contain no unresolved workspace imports and use a sandbox-compatible preload.');
