import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'positions:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts'],
    },
  },
});
