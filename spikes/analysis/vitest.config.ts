import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['render/**/*.test.ts', 'ts/**/*.test.ts'],
    maxWorkers: 2,
  },
});
