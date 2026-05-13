import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'liquidity:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/dto/**'],
    },
  },
});
