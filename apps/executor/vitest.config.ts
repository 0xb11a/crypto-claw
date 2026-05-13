import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'executor:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
