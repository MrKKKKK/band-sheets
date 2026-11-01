import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';

// Written by the globalSetup (e2e/support/micFakeAudio.ts) before any browser launches; keep the path in sync.
const MIC_FAKE_WAV = join(
  import.meta.dirname,
  'test-results/analysis-audio/mic-fake-40s.wav',
);

export default defineConfig({
  testDir: './e2e',
  // writes the fake microphone's wav before any browser launches (the `mic` project)
  globalSetup: './e2e/support/globalSetup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: [
        /(viewer|tablet)\.spec/,
        /e2e\/csp\//,
        /e2e\/perf\//,
        /e2e\/mic\.spec/,
      ],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // 「マイクで録る」 with Chromium's fake microphone playing a generated wav (e2e/support/micFakeAudio.ts). The
      // fake-media flags are only here: the other projects must keep seeing "no microphone".
      name: 'mic',
      testMatch: /e2e\/mic\.spec/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-audio-capture=${MIC_FAKE_WAV}`,
          ],
        },
      },
    },
    {
      // iPad Pro 11 landscape (1194x834, touch). The descriptor's default
      // browser is WebKit; the container only has chromium.
      name: 'tablet',
      testMatch: /(viewer|tablet)\.spec/,
      use: {
        ...devices['iPad Pro 11 landscape'],
        browserName: 'chromium',
      },
    },
  ],
  webServer: {
    // Own port: never reuse (or collide with) a dev server the user runs on
    // 5173 without the fake client ID.
    command: 'npm run dev -- --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: false,
    // A fake client ID so the app is "configured"; e2e/support/fakeDrive.ts
    // stubs GIS and the Drive API, nothing ever reaches Google.
    env: {
      VITE_GOOGLE_CLIENT_ID: 'e2e-fake-client-id.apps.googleusercontent.com',
    },
  },
});
