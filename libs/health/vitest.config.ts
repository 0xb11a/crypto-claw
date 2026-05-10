import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'health:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
