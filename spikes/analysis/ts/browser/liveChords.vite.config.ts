/**
 * Vite config for the live chord-check page only (docs/live-chord-tool-plan.md; not the app). Serve inside the devcontainer:
 *   docker exec -d -u node -w /workspaces/band-sheets/<worktree>/spikes/analysis band-sheets \
 *     npx vite --config ts/browser/liveChords.vite.config.ts
 * then open http://localhost:5188/liveChords.html in the PC's Chromium (VS Code port forwarding; localhost is a secure
 * context, so getUserMedia works). `server.host: true` because localhost is ::1 in the container (CLAUDE.md). The Playwright
 * smoke test (liveChords.spec.ts) uses a production build on `vite preview` (5189).
 */
import { join } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  server: { host: true, port: 5188, strictPort: true, hmr: false },
  preview: { host: true, port: 5189, strictPort: true },
  worker: { format: 'es' },
  build: {
    outDir: join(import.meta.dirname, '../../out/live/dist'),
    emptyOutDir: true,
    rollupOptions: { input: join(import.meta.dirname, 'liveChords.html') },
  },
});
