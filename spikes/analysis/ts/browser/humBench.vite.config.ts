/** Vite config for the humming bench page only (spike 4 T7): production build (no dev WebSocket) served by `vite preview`. */
import { join } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  server: { host: true, port: 5182, strictPort: true, hmr: false },
  preview: { host: true, port: 5183, strictPort: true },
  worker: { format: 'es' },
  build: {
    outDir: join(import.meta.dirname, '../../out/hum/dist'),
    emptyOutDir: true,
    rollupOptions: { input: join(import.meta.dirname, 'humBench.html') },
  },
});
