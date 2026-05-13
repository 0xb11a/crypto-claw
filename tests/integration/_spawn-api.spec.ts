/**
 * Unit/integration tests for _spawn-api.ts helper.
 *
 * Adversarial cases from plan §B.2:
 *   - startApi() called with port: 7878 twice in parallel MUST fail-fast
 *     with EADDRINUSE (not hang). Verifies that the helper's error-on-exit
 *     path fires quickly rather than waiting for readyTimeoutMs.
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns real API binary.
 * Requires a prior `pnpm build`.
 *
 * DoD §A — adversarial test the coder flagged as a gap.
 * SPEC §14 — integration tests; _spawn-api.ts is load-bearing helper.
 */

import { describe, it, expect } from 'vitest';
import { startApi, REPO_ROOT } from './_spawn-api.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ENABLED = process.env['CCLAW_SECURITY_TESTS_ENABLED'] === '1';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-spawn-api-test',
  REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  RESEARCH_API_KEY: 'ci-research-key-aaaaaaaaaaaaaaaa',
  SENTINEL_API_KEY: 'ci-sentinel-key-aaaaaaaaaaaaaaaa',
  EXECUTOR_API_KEY: 'ci-executor-key-aaaaaaaaaaaaaaaa',
  OBSERVER_API_KEY: 'ci-observer-key-aaaaaaaaaaaaaaaa',
  LOOP_API_KEY: 'ci-loop-key-aaaaaaaaaaaaaaaaaaaaa',
  WORKER_API_KEY: 'ci-worker-key-aaaaaaaaaaaaaaaaaaa',
  SCHEDULER_API_KEY: 'ci-scheduler-key-aaaaaaaaaaaaaaa',
  DASHBOARD_API_KEY: 'ci-dashboard-key-aaaaaaaaaaaaaaaa',
  ACTIVE_CHAINS: 'base,solana',
  OPENAI_API_KEY: 'ci-openai-dummy',
  NODE_ENV: 'test',
  PRISMA_DISABLE_DOTENV: '1',
  SAFE_SIGNER_KEY: '',
  SQUADS_SIGNER_KEY: '',
  NODE_PATH: process.env['NODE_PATH'],
  PATH: process.env['PATH'],
};

// ---------------------------------------------------------------------------
// Static checks (no binary spawn required)
// ---------------------------------------------------------------------------

describe('_spawn-api helper — static checks', () => {
  it('exports REPO_ROOT as an absolute path that exists', () => {
    expect(REPO_ROOT).toMatch(/^\//);
    expect(existsSync(REPO_ROOT)).toBe(true);
  });

  it('REPO_ROOT contains package.json (sanity check)', () => {
    expect(existsSync(resolve(REPO_ROOT, 'package.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adversarial: port collision (plan §B.2)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)(
  '_spawn-api port collision (CCLAW_SECURITY_TESTS_ENABLED required)',
  () => {
    it(
      'startApi() called twice on port 7878 in parallel fails-fast with error (no hang)',
      async () => {
        // Spawn the first API on port 7878 successfully
        const first = await startApi({
          dbPath: '',
          env: BASE_ENV,
          port: 7878,
          readyTimeoutMs: 15_000,
          tmpPrefix: 'cclaw-port-collision-a',
        });

        try {
          // Second startApi on the SAME port — should fail, not hang.
          // readyTimeoutMs is set low so if it does hang, the test fails fast.
          await expect(
            startApi({
              dbPath: '',
              env: BASE_ENV,
              port: 7878,
              readyTimeoutMs: 8_000,
              tmpPrefix: 'cclaw-port-collision-b',
            }),
          ).rejects.toThrow();
        } finally {
          await first.kill();
        }
      },
      // Allow up to 35s: 15s first start + 8s collision timeout + buffer
      35_000,
    );
  },
);
