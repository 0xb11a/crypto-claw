import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'chain:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
