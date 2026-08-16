import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@oldfolio/ai',
          '@oldfolio/domain',
          '@oldfolio/ingest',
          '@oldfolio/media',
          '@oldfolio/okf',
          '@oldfolio/plugin-sdk',
          '@oldfolio/sync',
          '@oldfolio/vault',
        ],
      }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve('src/preload/index.ts'), formats: ['cjs'] },
      rollupOptions: { output: { entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react()],
  },
});
