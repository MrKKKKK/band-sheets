/**
 * Playwright config for the bass perf run (spike 6 T12) only (devcontainer Chromium):
 *   docker exec -u node -w /workspaces/band-sheets band-sheets \
 *     npx playwright test --config spikes/analysis/ts/browser/bassPerf.playwright.config.ts
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: /bassPerf\.spec\.ts$/,
  outputDir: '../../out/bass-perf/test-results',
  workers: 1,
  reporter: 'list',
  timeout: 3_000_000,
  use: { baseURL: 'http://127.0.0.1:5187', ...devices['Desktop Chrome'] },
  webServer: {
    command:
      'npx vite build --config spikes/analysis/ts/browser/bassBench.vite.config.ts && npx vite preview --config spikes/analysis/ts/browser/bassBench.vite.config.ts',
    cwd: '../../../..',
    url: 'http://127.0.0.1:5187/bassBench.html',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
