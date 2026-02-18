import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['mobile-test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    teardownTimeout: 60_000,
  },
});
