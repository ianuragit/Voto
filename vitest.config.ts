import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Each file gets its own worker, and therefore its own pair of databases.
    fileParallelism: true,
    testTimeout: 20_000,
  },
});
