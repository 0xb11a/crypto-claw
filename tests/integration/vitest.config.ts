import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'integration',
    include: ['**/*.spec.ts'],
    environment: 'node',
    // Integration tests spawn child processes and may take longer
    testTimeout: 30000,
    // Disable file-level parallelism: multiple spec files each spawn an API
    // process that binds 127.0.0.1:7878. Running files concurrently causes
    // EADDRINUSE and "API exited with code 1" failures in beforeAll hooks.
    fileParallelism: false,
  },
});
