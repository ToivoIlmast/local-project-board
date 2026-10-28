import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src/web', import.meta.url)) },
  },
  // The board's event stream lives in a SharedWorker (ADR-0031), built as a module of its own.
  worker: { format: 'es' },
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
});
