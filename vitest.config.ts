import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts', 'src/providers/storage-provider.ts'],
      reporter: ['text', 'text-summary', 'lcov'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 70 },
    },
  },
});
