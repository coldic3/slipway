import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/functional/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
