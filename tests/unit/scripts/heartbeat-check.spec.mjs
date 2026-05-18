/**
 * Unit tests for scripts/heartbeat-check.js — cclaw-mediated path.
 *
 * SPEC §14 — unit tests mock the layer below (execSync).
 * DoD §A   — each test fails without the ported cclaw path.
 *
 * Tests cover:
 *   1. executor + idle (no pending sells or buys)
 *   2. executor + work-found (≥1 pending sell or buy)
 *   3. sentinel + real-mode + idle
 *   4. sentinel + real-mode + work-found
 *   5. sentinel + paper-mode + idle
 *   6. sentinel + paper-mode + work-found
 *   7. cclaw failure (execSync throws) → fallback skip=false
 *   8. cclaw returns malformed JSON → fallback skip=false
 *
 * The script is spawned as a child process with execSync mocked via the
 * vi.mock() / module mocking approach. Since the script is ESM and uses
 * top-level side-effects (reads process.argv at module load), we test
 * it by spawning it as a subprocess and stubbing execSync at the OS level
 * via a fixture script approach — OR by isolating the exported functions.
 *
 * Because heartbeat-check.js does NOT export its helper functions (they run
 * as a main script), we test it end-to-end by spawning the Node.js process
 * with a mock `cclaw` binary on PATH that returns canned JSON.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/heartbeat-check.js');

/**
 * Create a temporary directory containing a fake `cclaw` shell script.
 * The fake cclaw echoes JSON responses based on the subcommand arguments.
 *
 * @param {Record<string, string>} commandOutputs - Maps "orders list --status approved --action sell" → JSON string
 * @param {boolean} shouldThrow - If true, cclaw exits 1 (simulates failure)
 * @param {string|null} malformedOutput - If set, cclaw outputs this invalid JSON
 * @returns {{ binDir: string, cleanup: () => void }}
 */
function createFakeCclawBin(commandOutputs = {}, shouldThrow = false, malformedOutput = null) {
  const binDir = mkdtempSync(resolve(tmpdir(), 'cclaw-fake-'));

  let scriptBody;

  if (shouldThrow) {
    scriptBody = `#!/bin/sh\nexit 1\n`;
  } else if (malformedOutput !== null) {
    scriptBody = `#!/bin/sh\necho '${malformedOutput}'\nexit 0\n`;
  } else {
    // Build a dispatch table: check args and echo the right JSON.
    // We use the full arg string match for determinism.
    const cases = Object.entries(commandOutputs)
      .map(([argMatch, output]) => {
        // Escape single quotes in output for shell safety
        const safeOutput = output.replace(/'/g, "'\\''");
        return `  *"${argMatch}"*) echo '${safeOutput}' ;;`;
      })
      .join('\n');

    scriptBody = `#!/bin/sh
ARGS="$*"
case "$ARGS" in
${cases}
  *) echo '{"data":[]}' ;;
esac
exit 0
`;
  }

  const binPath = resolve(binDir, 'cclaw');
  writeFileSync(binPath, scriptBody, 'utf-8');
  chmodSync(binPath, 0o755);

  return {
    binDir,
    cleanup: () => rmSync(binDir, { recursive: true, force: true }),
  };
}

/**
 * Run the heartbeat-check script with the given args and fake cclaw environment.
 */
function runHeartbeatCheck(args, fakeBinDir, extraEnv = {}) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf-8',
      timeout: 10_000,
      env: {
        PATH: `${fakeBinDir}:${process.env['PATH'] ?? ''}`,
        NODE_PATH: process.env['NODE_PATH'] ?? '',
        PAPER_MODE: 'false',
        ...extraEnv,
      },
    });
    return { exitCode: 0, stdout };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

// ---------------------------------------------------------------------------
// Case 1: executor + idle (no pending sells or buys)
// ---------------------------------------------------------------------------

describe('heartbeat-check — executor idle (no pending orders)', () => {
  it('exits 0 and outputs skip=true with reason "no pending orders"', () => {
    const { binDir, cleanup } = createFakeCclawBin({
      'orders list --status approved --action sell --limit 1': '{"data":[]}',
      'orders list --status approved --action buy --limit 1': '{"data":[]}',
    });

    try {
      const { exitCode, stdout } = runHeartbeatCheck(['--agent', 'executor'], binDir);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.agent).toBe('executor');
      expect(parsed.skip).toBe(true);
      expect(parsed.reason).toBe('no pending orders');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Case 2: executor + work-found (≥1 pending sell or buy)
// ---------------------------------------------------------------------------

describe('heartbeat-check — executor work-found (pending sell)', () => {
  it('exits 0 and outputs skip=false with pending_sells=1, pending_buys=0', () => {
    const { binDir, cleanup } = createFakeCclawBin({
      'orders list --status approved --action sell --limit 1': '{"data":[{"id":"order-1"}]}',
      'orders list --status approved --action buy --limit 1': '{"data":[]}',
    });

    try {
      const { exitCode, stdout } = runHeartbeatCheck(['--agent', 'executor'], binDir);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.agent).toBe('executor');
      expect(parsed.skip).toBe(false);
      expect(parsed.pending_sells).toBe(1);
      expect(parsed.pending_buys).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('exits 0 and outputs skip=false with pending_sells=0, pending_buys=1', () => {
    const { binDir, cleanup } = createFakeCclawBin({
      'orders list --status approved --action sell --limit 1': '{"data":[]}',
      'orders list --status approved --action buy --limit 1': '{"data":[{"id":"order-2"}]}',
    });

    try {
      const { exitCode, stdout } = runHeartbeatCheck(['--agent', 'executor'], binDir);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.agent).toBe('executor');
      expect(parsed.skip).toBe(false);
      expect(parsed.pending_buys).toBe(1);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Case 3: sentinel + real-mode + idle
// ---------------------------------------------------------------------------

describe('heartbeat-check — sentinel real-mode idle', () => {
  it('exits 0 and outputs skip=true with reason "no open positions"', () => {
    const { binDir, cleanup } = createFakeCclawBin({
      'positions list --status open --mode real --limit 1': '{"data":[]}',
      'positions list --status partial_exit --mode real --limit 1': '{"data":[]}',
    });

    try {
      const { exitCode, stdout } = runHeartbeatCheck(['--agent', 'sentinel'], binDir, {
        PAPER_MODE: 'false',
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.agent).toBe('sentinel');
      expect(parsed.skip).toBe(true);
      expect(parsed.reason).toBe('no open positions');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Case 4: sentinel + real-mode + work-found
// ---------------------------------------------------------------------------

describe('heartbeat-check — sentinel real-mode work-found', () => {
  it('exits 0 and outputs skip=false with open_positions=1', () => {
    const { binDir, cleanup } = createFakeCclawBin({
      'positions list --status open --mode real --limit 1': '{"data":[{"id":"pos-1"}]}',
      'positions list --status partial_exit --mode real --limit 1': '{"data":[]}',
    });

    try {
      const { exitCode, stdout } = runHeartbeatCheck(['--agent', 'sentinel'], binDir, {
        PAPER_MODE: 'false',
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.agent).toBe('sentinel');
      expect(parsed.skip).toBe(false);
      expect(parsed.open_positions).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('counts both open and partial_exit positions', () => {
    const { binDir, cleanup } = createFakeCclawBin({
      'positions list --status open --mode real --limit 1': '{"data":[{"id":"pos-1"}]}',
      'positions list --status partial_exit --mode real --limit 1': '{"data":[{"id":"pos-2"}]}',
    });

    try {
      const { exitCode, stdout } = runHeartbeatCheck(['--agent', 'sentinel'], binDir, {
        PAPER_MODE: 'false',
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.open_positions).toBe(2);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Case 5: sentinel + paper-mode + idle
// ---------------------------------------------------------------------------

describe('heartbeat-check — sentinel paper-mode idle', () => {
  it('exits 0, uses paper mode flag, outputs skip=true', () => {
    const { binDir, cleanup } = createFakeCclawBin({
      'positions list --status open --mode paper --limit 1': '{"data":[]}',
      'positions list --status partial_exit --mode paper --limit 1': '{"data":[]}',
    });

    try {
      const { exitCode, stdout } = runHeartbeatCheck(['--agent', 'sentinel'], binDir, {
        PAPER_MODE: 'true',
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.agent).toBe('sentinel');
      expect(parsed.skip).toBe(true);
      expect(parsed.reason).toBe('no open positions');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Case 6: sentinel + paper-mode + work-found
// ---------------------------------------------------------------------------

describe('heartbeat-check — sentinel paper-mode work-found', () => {
  it('exits 0, uses paper mode, outputs skip=false with open_positions=1', () => {
    const { binDir, cleanup } = createFakeCclawBin({
      'positions list --status open --mode paper --limit 1': '{"data":[{"id":"paper-pos-1"}]}',
      'positions list --status partial_exit --mode paper --limit 1': '{"data":[]}',
    });

    try {
      const { exitCode, stdout } = runHeartbeatCheck(['--agent', 'sentinel'], binDir, {
        PAPER_MODE: 'true',
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.agent).toBe('sentinel');
      expect(parsed.skip).toBe(false);
      expect(parsed.open_positions).toBe(1);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Case 7: cclaw failure (execSync throws) → fallback skip=false
// ---------------------------------------------------------------------------

describe('heartbeat-check — cclaw failure fallback', () => {
  it('executor: exits 0 and outputs skip=false when cclaw exits non-zero', () => {
    const { binDir, cleanup } = createFakeCclawBin({}, /* shouldThrow */ true);

    try {
      const { exitCode, stdout } = runHeartbeatCheck(['--agent', 'executor'], binDir);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.agent).toBe('executor');
      // Safe direction: wake the agent when cclaw is down
      expect(parsed.skip).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('sentinel: exits 0 and outputs skip=false when cclaw exits non-zero', () => {
    const { binDir, cleanup } = createFakeCclawBin({}, /* shouldThrow */ true);

    try {
      const { exitCode, stdout } = runHeartbeatCheck(['--agent', 'sentinel'], binDir, {
        PAPER_MODE: 'false',
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.agent).toBe('sentinel');
      expect(parsed.skip).toBe(false);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Case 8: cclaw returns malformed JSON → fallback skip=false
// ---------------------------------------------------------------------------

describe('heartbeat-check — cclaw malformed JSON fallback', () => {
  it('executor: exits 0 and outputs skip=false when cclaw returns invalid JSON', () => {
    const { binDir, cleanup } = createFakeCclawBin({}, false, 'not-valid-json{');

    try {
      const { exitCode, stdout } = runHeartbeatCheck(['--agent', 'executor'], binDir);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.agent).toBe('executor');
      // Malformed JSON falls back to skip=false (safe direction)
      expect(parsed.skip).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('sentinel: exits 0 and outputs skip=false when cclaw returns invalid JSON', () => {
    const { binDir, cleanup } = createFakeCclawBin({}, false, 'not-valid-json{');

    try {
      const { exitCode, stdout } = runHeartbeatCheck(['--agent', 'sentinel'], binDir, {
        PAPER_MODE: 'false',
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.agent).toBe('sentinel');
      expect(parsed.skip).toBe(false);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Edge: invalid --agent argument → exit 1
// ---------------------------------------------------------------------------

describe('heartbeat-check — invalid agent argument', () => {
  it('exits 1 when --agent is missing', () => {
    const { binDir, cleanup } = createFakeCclawBin();

    try {
      const { exitCode } = runHeartbeatCheck([], binDir);
      expect(exitCode).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('exits 1 when --agent has an unknown value', () => {
    const { binDir, cleanup } = createFakeCclawBin();

    try {
      const { exitCode } = runHeartbeatCheck(['--agent', 'research'], binDir);
      expect(exitCode).toBe(1);
    } finally {
      cleanup();
    }
  });
});
