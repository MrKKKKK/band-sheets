/** Vite config for the drum bench page only (spike 5 T8): production build (no dev WebSocket) served by `vite preview`. */
import { join } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  server: { host: true, port: 5184, strictPort: true, hmr: false },
  preview: { host: true, port: 5185, strictPort: true },
  worker: { format: 'es' },
  build: {
    outDir: join(import.meta.dirname, '../../out/drum/dist'),
    emptyOutDir: true,
    rollupOptions: { input: join(import.meta.dirname, 'drumBench.html') },
  },
});
