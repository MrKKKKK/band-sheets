/// <reference types="vitest/config" />
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Inside the devcontainer `localhost` resolves to ::1, so Vite's default
    // binds IPv6 loopback only, while VS Code's port forwarding connects to
    // 127.0.0.1 (ECONNREFUSED). Listen on all addresses instead.
    host: true,
    // OAuth's "authorized JavaScript origins" (http://localhost:5173) must
    // match, so never fall back to another port.
    port: 5173,
    strictPort: true,
  },
  test: {
    // Keep worker count low: full-suite runs used to take down WSL in
    // sheet-for-player. Raise only after investigating that separately.
    maxWorkers: 2,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
      {
        extends: true,
        // Runs every story as a test in real Chromium (devcontainer only).
        plugins: [
          storybookTest({
            configDir: path.join(import.meta.dirname, '.storybook'),
          }),
        ],
        test: {
          name: 'storybook',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
