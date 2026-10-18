/**
 * Playwright config for the humming perf run (T12) only (devcontainer Chromium):
 *   docker exec -u node -w /workspaces/band-sheets band-sheets \
 *     npx playwright test --config spikes/analysis/ts/browser/humPerf.playwright.config.ts
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: /humPerf\.spec\.ts$/,
  outputDir: '../../out/hum/test-results',
  workers: 1,
  reporter: 'list',
  timeout: 600_000,
  use: { baseURL: 'http://127.0.0.1:5183', ...devices['Desktop Chrome'] },
  webServer: {
    command:
      'npx vite build --config spikes/analysis/ts/browser/humBench.vite.config.ts && npx vite preview --config spikes/analysis/ts/browser/humBench.vite.config.ts',
    cwd: '../../../..',
    url: 'http://127.0.0.1:5183/humBench.html',
    reuseExistingServer: false,
    timeout: 600_000,
  },
});
