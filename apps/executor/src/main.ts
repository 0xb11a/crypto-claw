/**
 * apps/executor — plain Node process (NOT NestJS).
 *
 * Per ADR-0010, the executor is an ephemeral subprocess spawned per order
 * by apps/worker's libs/execution/spawn helper. It is the ONLY process
 * that may hold SAFE_SIGNER_KEY and SQUADS_SIGNER_KEY in its env.
 *
 * This module deliberately does NOT call assertNoSignerKeysInEnv().
 *
 * Boot sequence:
 * 1. assertConfigValid — exits 78 if config is invalid
 * 2. Print stub JSON receipt and exit 0 (P0 placeholder)
 *
 * Full implementation lands in P3 when libs/execution/spawn is wired.
 */
import { assertConfigValid } from '@cclaw/config';

// Step 1 — config validation. Does NOT check for signer keys (ADR-0010).
assertConfigValid(process.env);

// Step 2 — P0 stub: print a JSON receipt indicating not-yet-implemented.
// eslint-disable-next-line no-console
console.log(JSON.stringify({ status: 'not_yet_implemented', phase: 'P0' }));

process.exit(0);
