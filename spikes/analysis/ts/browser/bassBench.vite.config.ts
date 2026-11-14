/** Vite config for the bass bench page only (spike 6 T7): production build (no dev WebSocket) served by `vite preview`. */
import { join } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  server: { host: true, port: 5186, strictPort: true, hmr: false },
  preview: { host: true, port: 5187, strictPort: true },
  worker: { format: 'es' },
  build: {
    outDir: join(import.meta.dirname, '../../out/bass-bench/dist'),
    emptyOutDir: true,
    rollupOptions: { input: join(import.meta.dirname, 'bassBench.html') },
  },
});
