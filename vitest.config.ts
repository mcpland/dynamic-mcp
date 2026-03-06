import { defineConfig } from 'vitest/config';

const isCi = process.env.CI === 'true' || process.env.CI === '1';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: isCi ? 15_000 : 5_000,
    hookTimeout: isCi ? 20_000 : 10_000,
    ...(isCi ? { maxWorkers: 1 } : {})
  }
});
