/**
 * Playwright config for the live chord-check smoke test (devcontainer Chromium, fake input device playing a self-made wav):
 *   docker exec -u node -w /workspaces/band-sheets/<worktree> band-sheets \
 *     npx playwright test --config spikes/analysis/ts/browser/liveChords.playwright.config.ts
 * The wav is written by globalSetup (liveChords.fixture.ts) to spikes/analysis/out/live/ (gitignored).
 */
import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { FAKE_WAV } from './liveChords.fixture';

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: /liveChords\.spec\.ts$/,
  outputDir: '../../out/live/test-results',
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  globalSetup: join(import.meta.dirname, 'liveChords.fixture.ts'),
  use: {
    baseURL: 'http://127.0.0.1:5189',
    ...devices['Desktop Chrome'],
    permissions: ['microphone'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${FAKE_WAV}`, '--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: {
    command: 'npx vite build --config spikes/analysis/ts/browser/liveChords.vite.config.ts && npx vite preview --config spikes/analysis/ts/browser/liveChords.vite.config.ts',
    cwd: '../../../..',
    url: 'http://127.0.0.1:5189/liveChords.html',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
