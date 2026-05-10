import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'prisma:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
