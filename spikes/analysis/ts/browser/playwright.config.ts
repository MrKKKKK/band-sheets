/**
 * Playwright config for the T16 / T19 bench only (devcontainer Chromium):
 *   docker exec -u node -w /workspaces/band-sheets band-sheets \
 *     npx playwright test --config spikes/analysis/ts/browser/playwright.config.ts
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: /bench\.spec\.ts$/,
  outputDir: '../../out/t19/test-results',
  workers: 1,
  reporter: 'list',
  timeout: 600_000,
  use: {
    baseURL: 'http://127.0.0.1:5181',
    ...devices['Desktop Chrome'],
    launchOptions: { args: ['--enable-precise-memory-info'] },
  },
  webServer: {
    // production build + vite preview: no dev client, no WebSocket (see vite.config.ts)
    command:
      'npx vite build --config spikes/analysis/ts/browser/vite.config.ts && npx vite preview --config spikes/analysis/ts/browser/vite.config.ts',
    cwd: '../../../..',
    url: 'http://127.0.0.1:5181/bench.html',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
