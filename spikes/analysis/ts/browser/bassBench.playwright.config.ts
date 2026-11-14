/**
 * Playwright config for the bass bench only (devcontainer Chromium):
 *   docker exec -u node -w /workspaces/band-sheets band-sheets \
 *     npx playwright test --config spikes/analysis/ts/browser/bassBench.playwright.config.ts
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: /bassBench\.spec\.ts$/,
  outputDir: '../../out/bass-bench/test-results',
  workers: 1,
  reporter: 'list',
  timeout: 300_000,
  use: { baseURL: 'http://127.0.0.1:5187', ...devices['Desktop Chrome'], launchOptions: { args: ['--enable-precise-memory-info'] } },
  webServer: {
    command:
      'npx vite build --config spikes/analysis/ts/browser/bassBench.vite.config.ts && npx vite preview --config spikes/analysis/ts/browser/bassBench.vite.config.ts',
    cwd: '../../../..',
    url: 'http://127.0.0.1:5187/bassBench.html',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
