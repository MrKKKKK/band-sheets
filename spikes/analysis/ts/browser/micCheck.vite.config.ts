/**
 * Vite config for the T13 mic check page only (spike 4; not the app). Serve inside the devcontainer:
 *   docker exec -u node -w /workspaces/band-sheets/spikes/analysis band-sheets \
 *     npx vite --config ts/browser/micCheck.vite.config.ts
 * then open http://localhost:5182/micCheck.html from the host (VS Code port forwarding; localhost is a
 * secure context, so getUserMedia works). `server.host: true` because localhost is ::1 in the
 * container (CLAUDE.md). Port 5182 is shared with humBench's dev server: run one at a time. The
 * Playwright smoke check (micCheck.spec.ts) uses a production build on `vite preview` (5184).
 */
import { join } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  server: { host: true, port: 5182, strictPort: true, hmr: false },
  preview: { host: true, port: 5184, strictPort: true },
  build: {
    outDir: join(import.meta.dirname, '../../out/mic/dist'),
    emptyOutDir: true,
    rollupOptions: { input: join(import.meta.dirname, 'micCheck.html') },
  },
});
