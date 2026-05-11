import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'auth:unit',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        // auth.module.ts — NestJS DI wiring; covered by tests/integration/boot-defenses.spec.ts,
        // not by unit tests. Excluding matches the OPEN-T DTO exclusion pattern.
        // NOTE: in vitest v1 workspace mode, per-project coverage.exclude entries are not
        // propagated to the merged workspace coverage report. auth.module.ts therefore still
        // appears in the aggregate at 0% (82 lines: auth.module.ts + identities.decorator.ts
        // + index.ts). The aggregate sits at 84.84% — above the 80% Codecov gate; see OPEN-S.
        'src/auth.module.ts',
        // Decorator files are SetMetadata wrappers — no executable branches to cover.
        // Their correctness is verified indirectly via guard specs (RolesGuard, IdentityGuard).
        'src/roles.decorator.ts',
        'src/identities.decorator.ts',
        // index.ts is a re-export barrel — no logic to cover.
        'src/index.ts',
      ],
    },
  },
});
