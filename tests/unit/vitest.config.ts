import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'scripts:unit',
    include: ['**/*.spec.mjs', '**/*.spec.ts'],
    environment: 'node',
  },
});
