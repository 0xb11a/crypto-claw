import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'scheduler:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
