import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Electron 43 downloads its runtime lazily from the package entrypoint. electron-vite 5 reads
// path.txt directly, so loading Electron here is required before electron-vite starts the app.
const require = createRequire(import.meta.url);
/** @type {unknown} */
const loadedElectron = require('electron');

if (typeof loadedElectron !== 'string' || loadedElectron.length === 0) {
  throw new Error('Electron did not return an executable path after installation.');
}

const electronPath = loadedElectron;
await access(electronPath);
console.log(`Electron executable ready: ${electronPath}`);
