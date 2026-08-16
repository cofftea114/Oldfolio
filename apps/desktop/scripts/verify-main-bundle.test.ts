import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Electron main-process bundle', () => {
  it('does not defer workspace source packages to the Electron runtime', () => {
    const appDirectory = fileURLToPath(new URL('..', import.meta.url));
    const build = spawnSync('pnpm exec electron-vite build', {
      cwd: appDirectory,
      encoding: 'utf8',
      shell: true,
    });
    expect(build.status, build.stderr).toBe(0);

    const script = fileURLToPath(new URL('./verify-main-bundle.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('use a sandbox-compatible preload');
  }, 20_000);

  it('loads the packaged main process and renderer in Electron', () => {
    const script = fileURLToPath(new URL('./probe-startup.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 25_000 });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Electron main and renderer startup passed');
  });
});
