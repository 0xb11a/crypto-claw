import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'auth:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
