import { defineConfig, devices } from '@playwright/test';

/**
 * The CSP e2e (e2e/csp/): the PRODUCTION build (`vite build`, base /band-sheets/, CSP meta) served by
 * `vite preview` on its own port 5175, with the same fake GIS/Drive as `npm run e2e`. `npm run e2e:csp`.
 */
export default defineConfig({
  testDir: './e2e/csp',
  forbidOnly: !!process.env.CI,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5175/band-sheets/',
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
    // the mic harness (e2e/csp/csp.spec.ts): Chromium's fake mic, permission granted without a prompt
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    },
  },
  webServer: {
    command:
      'npx vite build --config e2e/vite.csp.config.ts --logLevel warn && npx vite preview --config e2e/vite.csp.config.ts',
    url: 'http://localhost:5175/band-sheets/',
    reuseExistingServer: false,
    timeout: 180_000,
    // Fake client ID (inlined at build time) so the app is "configured"; nothing reaches Google.
    env: {
      VITE_GOOGLE_CLIENT_ID: 'e2e-fake-client-id.apps.googleusercontent.com',
    },
  },
});
