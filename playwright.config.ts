import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
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
      testIgnore: /(viewer|tablet)\.spec/,
      use: { ...devices['Desktop Chrome'] },
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
