import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  // libs
  'libs/config/vitest.config.ts',
  'libs/logger/vitest.config.ts',
  // apps
  'apps/api/vitest.config.ts',
  'apps/worker/vitest.config.ts',
  'apps/scheduler/vitest.config.ts',
  'apps/executor/vitest.config.ts',
  // integration tests
  'tests/integration/vitest.config.ts',
]);
