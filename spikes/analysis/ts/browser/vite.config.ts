/**
 * Vite config for the T16 bench page only (not the app). Serve inside the devcontainer:
 *   docker exec -u node -w /workspaces/band-sheets band-sheets \
 *     npx vite --config spikes/analysis/ts/browser/vite.config.ts
 * then open http://localhost:5180/bench.html. `server.host: true` because localhost is ::1 in the
 * container (CLAUDE.md). The dev server's client always opens a (same-origin) WebSocket, so the
 * Playwright spec measures a production build served by `vite preview` instead (no WebSocket, no
 * @vite/client): `npx vite build --config ... && npx vite preview --config ...` (out/t16/dist).
 * Dev-only middleware serves the dev synthetic clip from gitignored out/ (never committed, never a
 * held-out variant or recording): ./clip.wav (44.1 kHz render) and ./clip-y.f32 (Python's
 * librosa.load of the same file, for the resampler comparison). Without out/ they 404 and the page
 * falls back to an in-page synthesized signal.
 */
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const OUT = join(import.meta.dirname, '../../out');
const CLIP_VARIANT = 'full-t116-straight'; // dev (tuning) synthetic, level 0
const ASSETS: Record<string, [string, string]> = {
  '/clip.wav': [join(OUT, 'saints', `${CLIP_VARIANT}.wav`), 'audio/wav'],
  '/clip-y.f32': [join(OUT, 'parity', CLIP_VARIANT, 'y.f32'), 'application/octet-stream'],
};

type Next = () => void;
function serve(req: { url?: string }, res: NodeJS.WritableStream & { setHeader(k: string, v: string): void }, next: Next) {
  const a = ASSETS[(req.url ?? '').split('?')[0]];
  if (!a || !existsSync(a[0])) return next();
  res.setHeader('Content-Type', a[1]);
  createReadStream(a[0]).pipe(res);
}

function devClip(): Plugin {
  return {
    name: 'bench-dev-clip',
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [devClip()],
  server: { host: true, port: 5180, strictPort: true, hmr: false },
  preview: { host: true, port: 5181, strictPort: true },
  worker: { format: 'es' },
  build: {
    outDir: join(OUT, 't16', 'dist'),
    emptyOutDir: true,
    rollupOptions: { input: join(import.meta.dirname, 'bench.html') },
  },
});
