import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
/** @type {unknown} */
const loadedElectron = require('electron');
if (typeof loadedElectron !== 'string' || loadedElectron.length === 0) {
  throw new Error('Electron executable is unavailable. Run the Electron bootstrap first.');
}

const appDirectory = resolve(import.meta.dirname, '..');
const child = spawn(loadedElectron, [appDirectory, '--oldfolio-startup-probe'], {
  env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

const timeout = setTimeout(() => {
  child.kill();
}, 20_000);
/** @type {Promise<number | null>} */
const exitPromise = new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolveExit(code));
});
const exitCode = await exitPromise;
clearTimeout(timeout);

if (exitCode !== 0 || !stdout.includes('Oldfolio desktop startup probe passed.')) {
  throw new Error(`Electron startup probe failed with exit code ${String(exitCode)}.\n${stdout}\n${stderr}`);
}
console.log('Oldfolio Electron main and renderer startup passed.');
