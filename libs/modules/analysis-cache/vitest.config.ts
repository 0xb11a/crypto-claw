import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'analysis-cache:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        // SPEC §14 / DoD §A — DTO files are decorator metadata only; excluded from coverage
        'src/**/dto/**',
      ],
    },
  },
});
