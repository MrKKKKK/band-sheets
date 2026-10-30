/**
 * Playwright config for the T13 mic check smoke test only (devcontainer Chromium, fake mic):
 *   docker exec -u node -w /workspaces/band-sheets band-sheets \
 *     npx playwright test --config spikes/analysis/ts/browser/micCheck.playwright.config.ts
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: /micCheck\.spec\.ts$/,
  outputDir: '../../out/mic/test-results',
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:5184',
    ...devices['Desktop Chrome'],
    permissions: ['microphone'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: {
    command:
      'npx vite build --config spikes/analysis/ts/browser/micCheck.vite.config.ts && npx vite preview --config spikes/analysis/ts/browser/micCheck.vite.config.ts',
    cwd: '../../../..',
    url: 'http://127.0.0.1:5184/micCheck.html',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
