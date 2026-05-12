import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'execution:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
