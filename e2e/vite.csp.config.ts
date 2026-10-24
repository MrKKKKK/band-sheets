/**
 * Production build for e2e/csp/*.spec.ts (playwright.csp.config.ts): the app's own vite.config.ts (so the CSP
 * meta plugin and the Worker build are exactly the deployed ones) plus the analysis harness page as a second
 * input, with the GitHub Pages base path, into its own outDir so `dist/` is left alone.
 */
import path from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import app from '../vite.config.ts';

const ROOT = path.join(import.meta.dirname, '..');

export default mergeConfig(
  app,
  defineConfig({
    root: ROOT,
    base: '/band-sheets/',
    build: {
      outDir: path.join(ROOT, 'node_modules/.tmp/csp-e2e'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: path.join(ROOT, 'index.html'),
          harness: path.join(ROOT, 'e2e/harness/analysis.html'),
        },
      },
    },
    preview: { host: true, port: 5175, strictPort: true },
  }),
);
