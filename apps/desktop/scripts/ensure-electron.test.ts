import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Electron development runtime bootstrap', () => {
  it('resolves and verifies the executable before electron-vite starts', () => {
    const script = fileURLToPath(new URL('./ensure-electron.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Electron executable ready:');
    expect(result.stdout.toLowerCase()).toContain('electron.exe');
  });
});
