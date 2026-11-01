import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';

/** `npm run perf:mic` (e2e/perf/micMemory.spec.ts): not part of `npm run e2e`. Same dev server as the e2e (port 5174). */
// Written by the globalSetup (e2e/support/micFakeAudio.ts) before any browser launches; keep the path in sync.
const MIC_FAKE_LONG_WAV = join(
  import.meta.dirname,
  'test-results/analysis-audio/mic-fake-11min.wav',
);

export default defineConfig({
  testDir: './e2e/perf',
  globalSetup: './e2e/perf/perf.globalSetup.ts',
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5174',
    ...devices['Desktop Chrome'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${MIC_FAKE_LONG_WAV}`,
      ],
    },
  },
  webServer: {
    command: 'npm run dev -- --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: false,
    env: {
      VITE_GOOGLE_CLIENT_ID: 'e2e-fake-client-id.apps.googleusercontent.com',
    },
  },
});
