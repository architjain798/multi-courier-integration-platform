import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 120_000,
    coverage: {
      include: ['src/**'],
      exclude: ['src/**/*.types.ts', 'src/db/migrations/**'],
    },
  },
});
