import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['shared/**/*.ts', 'server/**/*.ts'],
      exclude: ['server/index.ts'],
      thresholds: {
        statements: 60,
        branches: 40,
        functions: 60,
        lines: 65,
      },
    },
  },
});
