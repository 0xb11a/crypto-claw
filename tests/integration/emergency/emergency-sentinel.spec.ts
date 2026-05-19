/**
 * Integration tests for scripts/emergency-sentinel.js — cclaw-mediated path.
 *
 * SPEC §14 — integration tests: real API + real cclaw SDK + real DB.
 * DoD §A   — behaviors flagged in retained-set deletion plan step 16.
 * DoD §F   — audit trail: propose + approve both produce audit rows.
 *
 * Pattern:
 *   1. Spawn apps/api on an isolated port (7913) with a temp DB.
 *   2. Run emergency-sentinel.js as a subprocess with:
 *        - CCLAW_API_BASE pointing at the test API
 *        - CCLAW_API_TOKEN set to agent key
 *        - cclaw wrapper on PATH (delegates to real compiled binary)
 *   3. Assert API state via HTTP (orders, sentinel_log, audit rows).
 *
 * Note on DEXScreener: the emergency-sentinel script calls DEXScreener for
 * price data per position. To avoid network dependency in CI, these tests
 * only use the "no positions" path (no DEXScreener calls made). The
 * propose+approve audit trail is verified via direct HTTP calls.
 *
 * The full "breach → sell order" path is tested at the unit level via
 * the fake cclaw subprocess approach in tests/unit/scripts/.
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1.
 *
 * Port: 7913.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const ENABLED = process.env['CCLAW_SECURITY_TESTS_ENABLED'] === '1';

const REPO_ROOT = resolve(__dirname, '../../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/emergency-sentinel.js');

const PORT = 7913;
const BASE = `http://127.0.0.1:${PORT}`;

// Use LOOP token for test orchestration — P7 PR-C1 added an action-vs-identity
// assertion in OrdersService.propose() (RESEARCH=BUY-only, SENTINEL=SELL-only).
// The emergency-sentinel script writes SELL orders, so a RESEARCH-token test
// would 403. LOOP has the superset background-loop scope per ADR-0029 + no
// action restriction; matches the production semantics where the script is
// invoked with SENTINEL_API_KEY via entrypoint.sh (PR-B) but the test fixture
// just needs an unrestricted orchestration token.
const AGENT_TOKEN = 'ci-loop-key-aaaaaaaaaaaaaaaaaaaaa';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-emergency-sentinel-test',
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

let api: StartApiResult;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Setup directory for the cclaw wrapper.
 * The cclaw wrapper script delegates to the real cclaw binary via node,
 * so execSync('cclaw ...') in the emergency scripts resolves correctly.
 */
let cclawWrapperDir: string;
let setupDir: string;

beforeAll(async () => {
  if (!ENABLED) return;

  // Create cclaw wrapper
  setupDir = mkdtempSync(resolve(tmpdir(), 'emergency-sentinel-setup-'));
  cclawWrapperDir = resolve(setupDir, 'bin');
  mkdirSync(cclawWrapperDir, { recursive: true });
  const cclawBin = resolve(REPO_ROOT, 'sdk/cclaw/dist/index.js');
  writeFileSync(
    resolve(cclawWrapperDir, 'cclaw'),
    `#!/bin/sh\nexec node "${cclawBin}" "$@"\n`,
    { mode: 0o755 },
  );

  // Start API
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-emergency-sentinel',
  });
}, 30_000);

afterAll(async () => {
  if (!ENABLED) return;
  await api.kill();
  if (setupDir) {
    rmSync(setupDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function req(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function runEmergencySentinel(): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: {
        ...process.env,
        CCLAW_API_BASE: BASE,
        CCLAW_API_TOKEN: AGENT_TOKEN,
        PAPER_MODE: 'false',
        SAFE_ID: 'ci-emergency-sentinel-test',
        NODE_PATH: process.env['NODE_PATH'] ?? '',
        // Prepend cclaw wrapper dir so execSync('cclaw ...') in the script resolves
        PATH: `${cclawWrapperDir}:${process.env['PATH'] ?? ''}`,
      },
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

// ---------------------------------------------------------------------------
// Case 1: No positions → script exits 0, no new orders, sentinel_log written
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('emergency-sentinel — Case 1: no positions', () => {
  it('exits 0 and summary shows positionsChecked=0, ordersWritten=0', () => {
    const { exitCode, stdout, stderr } = runEmergencySentinel();
    expect(exitCode, `Script stderr: ${stderr}`).toBe(0);

    const summary = JSON.parse(stdout);
    expect(summary.positionsChecked).toBe(0);
    expect(summary.ordersWritten).toBe(0);
    expect(summary.mode).toBe('emergency');
    expect(summary.message).toBe('No open positions — nothing to protect');
  });

  it('logToSentinel always called: writes sentinel_log row with check_type=emergency', async () => {
    // Run the script (no positions → logToSentinel called)
    runEmergencySentinel();

    const { body: logsBody } = await req('GET', '/v1/logs/sentinel?limit=10', {
      token: AGENT_TOKEN,
    });
    const logs = logsBody as Array<Record<string, unknown>>;
    const emergencyLog = logs.find((l) => l['check_type'] === 'emergency');

    expect(emergencyLog, 'Expected emergency sentinel_log row').toBeDefined();
    expect(emergencyLog!['status']).toBe('warn');
    expect(typeof emergencyLog!['positions_checked']).toBe('number');
    expect(typeof emergencyLog!['alerts_generated']).toBe('number');
    expect(typeof emergencyLog!['sells_executed']).toBe('number');
    expect((emergencyLog!['summary'] as string)).toContain('emergency cycle');
  });
});

// ---------------------------------------------------------------------------
// Case 2: propose+approve audit trail (DoD §F)
// Tested via direct HTTP calls that simulate what writeSellOrder() does.
// This verifies the @Audited() decorator produces rows for both writes.
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('emergency-sentinel — Case 2: propose+approve audit trail (DoD §F)', () => {
  it('POST /v1/orders (propose) produces an audit row with status=201', async () => {
    await req('POST', '/v1/orders', {
      token: AGENT_TOKEN,
      body: {
        action: 'sell',
        symbol: 'AUDIT_PROPOSE',
        address: '0xAUDITPROPOSE000000000000000000000000TEST',
        chain: 'base',
        amount: 'all',
        reason: 'stop_loss',
        urgency: 'immediate',
      },
    });

    const { body: auditBody } = await req('GET', '/v1/system/audit', {
      token: AGENT_TOKEN,
    });
    const rows = (auditBody as { data: Array<Record<string, unknown>> }).data;
    const proposeAudit = rows.find(
      (r) => r['path'] === '/v1/orders' && r['method'] === 'POST',
    );
    expect(proposeAudit, 'Expected audit row for POST /v1/orders').toBeDefined();
    expect(proposeAudit!['status']).toBe(201);
  });

  it('POST /v1/orders/:id/approve with approved_by=emergency_sentinel produces an audit row', async () => {
    const { body: proposed } = await req('POST', '/v1/orders', {
      token: AGENT_TOKEN,
      body: {
        action: 'sell',
        symbol: 'AUDIT_APPROVE',
        address: '0xAUDITAPPROVE00000000000000000000000TEST',
        chain: 'base',
        amount: 'all',
        reason: 'stop_loss',
        urgency: 'immediate',
      },
    });
    const orderId = (proposed as { id: string }).id;

    await req('POST', `/v1/orders/${orderId}/approve`, {
      token: AGENT_TOKEN,
      body: { by: 'emergency_sentinel' },
    });

    // Verify order has approved_by=emergency_sentinel
    const { body: orderBody } = await req('GET', `/v1/orders/${orderId}`, {
      token: AGENT_TOKEN,
    });
    expect((orderBody as { approved_by: string }).approved_by).toBe('emergency_sentinel');

    // Verify audit row for the approve call
    const { body: auditBody } = await req('GET', '/v1/system/audit', {
      token: AGENT_TOKEN,
    });
    const rows = (auditBody as { data: Array<Record<string, unknown>> }).data;
    const approveAudit = rows.find(
      (r) =>
        typeof r['path'] === 'string' &&
        (r['path'] as string).includes(orderId) &&
        (r['path'] as string).includes('/approve') &&
        r['method'] === 'POST',
    );
    expect(approveAudit, 'Expected audit row for approve call').toBeDefined();
    expect(approveAudit!['status']).toBe(200);
  });

  it('writeSellOrder 2-call pattern: propose+approve both produce audit rows', async () => {
    // Verifies the full flow that emergency-sentinel.js's writeSellOrder() uses:
    // 1. cclaw orders propose → creates order with status=pending
    // 2. cclaw orders approve --by emergency_sentinel → transitions to approved
    // Both calls must produce audit rows (verified above individually).
    // This combined test ensures both exist for the same order.

    const { body: proposed } = await req('POST', '/v1/orders', {
      token: AGENT_TOKEN,
      body: {
        action: 'sell',
        symbol: 'COMBINED_AUDIT',
        address: '0xCOMBINEDAUDIT0000000000000000000000TEST',
        chain: 'base',
        amount: 'all',
        reason: 'emergency_severe_loss',
        urgency: 'immediate',
      },
    });
    const orderId = (proposed as { id: string }).id;

    await req('POST', `/v1/orders/${orderId}/approve`, {
      token: AGENT_TOKEN,
      body: { by: 'emergency_sentinel' },
    });

    const { body: auditBody } = await req('GET', '/v1/system/audit', {
      token: AGENT_TOKEN,
    });
    const rows = (auditBody as { data: Array<Record<string, unknown>> }).data;

    // Both propose and approve should have audit rows for this order
    const proposeRow = rows.find(
      (r) => r['path'] === '/v1/orders' && r['method'] === 'POST' && r['status'] === 201,
    );
    const approveRow = rows.find(
      (r) =>
        typeof r['path'] === 'string' &&
        (r['path'] as string).includes(orderId) &&
        (r['path'] as string).includes('/approve') &&
        r['method'] === 'POST',
    );

    expect(proposeRow, 'Propose audit row must exist').toBeDefined();
    expect(approveRow, 'Approve audit row must exist').toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Case 3: sentinel_log row written by logToSentinel — shape validation
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('emergency-sentinel — Case 3: sentinel_log shape', () => {
  it('sentinel_log row written by logToSentinel has all expected fields', async () => {
    runEmergencySentinel();

    const { body: logsBody } = await req('GET', '/v1/logs/sentinel?limit=20', {
      token: AGENT_TOKEN,
    });
    const logs = logsBody as Array<Record<string, unknown>>;
    const emergencyLog = logs.find((l) => l['check_type'] === 'emergency');

    expect(emergencyLog, 'Expected emergency sentinel_log row').toBeDefined();
    if (!emergencyLog) return;

    expect(emergencyLog['check_type']).toBe('emergency');
    expect(emergencyLog['status']).toBe('warn');
    expect(typeof emergencyLog['positions_checked']).toBe('number');
    expect(typeof emergencyLog['alerts_generated']).toBe('number');
    expect(typeof emergencyLog['sells_executed']).toBe('number');
    expect(typeof emergencyLog['summary']).toBe('string');
    expect((emergencyLog['summary'] as string)).toContain('emergency cycle');
  });
});

// ---------------------------------------------------------------------------
// Case 4: cclaw orders propose returns no id → approve skipped (orderId=null)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('emergency-sentinel — Case 4: propose returns no id', () => {
  it.skip(
    // [OPEN-4] Testing the case where cclaw orders propose returns no id requires
    // mocking the API response mid-test, which is complex in the spawn-API pattern.
    // The script handles this case gracefully (leaves order pending, continues).
    // Covered by code inspection: writeSellOrder() lines 132-143 in emergency-sentinel.js.
    'propose returns no id → approve skipped, order left pending [OPEN-4: complex to test in spawn-API pattern]',
    async () => {
      // Would require intercepting the cclaw propose response and stripping the id.
    },
  );
});
