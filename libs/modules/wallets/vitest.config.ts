import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'wallets:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        // SPEC §14 / P1b OPEN-T — DTO files are decorator metadata only; excluded from coverage
        'src/**/dto/**',
      ],
    },
  },
});
