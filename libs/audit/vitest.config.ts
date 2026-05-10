import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'audit:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
