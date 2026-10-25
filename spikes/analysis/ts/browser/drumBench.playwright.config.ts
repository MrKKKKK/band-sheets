/**
 * Playwright config for the drum bench only (devcontainer Chromium):
 *   docker exec -u node -w /workspaces/band-sheets band-sheets \
 *     npx playwright test --config spikes/analysis/ts/browser/drumBench.playwright.config.ts
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: /drumBench\.spec\.ts$/,
  outputDir: '../../out/drum/test-results',
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  use: { baseURL: 'http://127.0.0.1:5185', ...devices['Desktop Chrome'] },
  webServer: {
    command:
      'npx vite build --config spikes/analysis/ts/browser/drumBench.vite.config.ts && npx vite preview --config spikes/analysis/ts/browser/drumBench.vite.config.ts',
    cwd: '../../../..',
    url: 'http://127.0.0.1:5185/drumBench.html',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
