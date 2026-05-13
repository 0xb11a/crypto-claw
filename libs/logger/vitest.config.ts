import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'logger:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
