import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
