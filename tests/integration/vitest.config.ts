import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'integration',
    include: ['**/*.spec.ts'],
    environment: 'node',
    // Integration tests spawn child processes and may take longer
    testTimeout: 30000,
  },
});
