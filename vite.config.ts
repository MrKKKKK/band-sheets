/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { injectCspMeta } from './src/lib/csp.ts';

const THIRD_PARTY = path.join(
  import.meta.dirname,
  'src/lib/analysis/THIRD_PARTY.md',
);

/**
 * The librosa (ISC) and fft.js (MIT) notices must stay in the built JS (docs/audio-integration-plan.md section 2.2).
 * Prepends one `/*! ... *\/` comment to every Worker chunk that holds analysis code, generated from
 * src/lib/analysis/THIRD_PARTY.md (each `## ` heading, its `License:` line and its ```text block), after
 * minification so it cannot be stripped. scripts/check-bundle.mjs checks the built chunks against that file.
 */
function analysisLicenseBanner(): Plugin {
  let banner = '';
  return {
    name: 'band-sheets:analysis-license-banner',
    buildStart() {
      const md = readFileSync(THIRD_PARTY, 'utf8');
      const parts = md.split(/^## /m).slice(1);
      const notices = parts.map((sec) => {
        const heading = sec.slice(0, sec.indexOf('\n')).trim();
        const license = /^License: .*$/m.exec(sec)?.[0];
        const text = /```text\n([\s\S]*?)```/.exec(sec)?.[1];
        if (!text)
          throw new Error(`THIRD_PARTY.md: no license text for ${heading}`);
        return [
          heading,
          ...(license ? [license] : []),
          '',
          text.trimEnd(),
        ].join('\n');
      });
      const body = [
        'band-sheets audio analysis Worker. Third-party notices (src/lib/analysis/THIRD_PARTY.md):',
        ...notices.map((n) => `\n${n}`),
      ].join('\n');
      if (body.includes('*/'))
        throw new Error('THIRD_PARTY.md text contains */');
      banner = `/*!\n${body}\n*/\n`;
    },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (
          chunk.type === 'chunk' &&
          chunk.moduleIds.some((id) => id.includes('/src/lib/analysis/'))
        )
          chunk.code = banner + chunk.code;
      }
    },
  };
}

/** Pages that get the CSP meta (paths as Vite's transformIndexHtml reports them). */
const CSP_PAGES = new Set(['/index.html', '/e2e/harness/analysis.html']);

/**
 * Adds the Content-Security-Policy `<meta>` (src/lib/csp.ts) to the built pages only. `apply: 'build'`: the dev
 * server's inline scripts / HMR websocket would violate it, and Storybook's iframe.html is not in CSP_PAGES.
 * scripts/check-bundle.mjs checks dist/index.html; e2e/csp.spec.ts runs the built app under it.
 */
function cspMeta(): Plugin {
  return {
    name: 'band-sheets:csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html, ctx) =>
        CSP_PAGES.has(ctx.path) ? injectCspMeta(html) : html,
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cspMeta()],
  optimizeDeps: {
    // fft.js is imported only by the analysis Workers, which the dep scanner does not follow from index.html.
    // Without this the dev server discovers it on the first Worker load, re-optimizes and RELOADS the page
    // (e2e: "Execution context was destroyed … navigation" on a cold node_modules/.vite cache).
    include: ['fft.js'],
  },
  build: {
    // Never inline fonts as data: URLs (a few tiny @fontsource subsets would be): the CSP's font-src is 'self'
    // only (src/lib/csp.ts). Other assets keep Vite's default 4 KB limit.
    assetsInlineLimit: (file) =>
      /\.(woff2?|otf|ttf)$/.test(file) ? false : undefined,
  },
  worker: {
    // the analysis Workers are module Workers (src/analysis/kinds.ts); one chunk per kind
    format: 'es',
    plugins: () => [analysisLicenseBanner()],
  },
  server: {
    // Inside the devcontainer `localhost` resolves to ::1, so Vite's default
    // binds IPv6 loopback only, while VS Code's port forwarding connects to
    // 127.0.0.1 (ECONNREFUSED). Listen on all addresses instead.
    host: true,
    // OAuth's "authorized JavaScript origins" (http://localhost:5173) must
    // match, so never fall back to another port.
    port: 5173,
    strictPort: true,
  },
  test: {
    // Keep worker count low: full-suite runs used to take down WSL in
    // sheet-for-player. Raise only after investigating that separately.
    maxWorkers: 2,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
      {
        extends: true,
        // Runs every story as a test in real Chromium (devcontainer only).
        plugins: [
          storybookTest({
            configDir: path.join(import.meta.dirname, '.storybook'),
          }),
        ],
        test: {
          name: 'storybook',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
