import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'worker:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
