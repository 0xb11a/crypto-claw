import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  // libs
  'libs/config/vitest.config.ts',
  'libs/logger/vitest.config.ts',
  'libs/prisma/vitest.config.ts',
  'libs/auth/vitest.config.ts',
  'libs/audit/vitest.config.ts',
  'libs/health/vitest.config.ts',
  'libs/modules/positions/vitest.config.ts',
  'libs/modules/orders/vitest.config.ts',
  'libs/modules/receipts/vitest.config.ts',
  'libs/modules/alerts/vitest.config.ts',
  'libs/modules/heartbeat/vitest.config.ts',
  // apps
  'apps/api/vitest.config.ts',
  'apps/worker/vitest.config.ts',
  'apps/scheduler/vitest.config.ts',
  'apps/executor/vitest.config.ts',
  // integration tests
  'tests/integration/vitest.config.ts',
]);
