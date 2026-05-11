/**
 * spawn-executor.ts — Spawns the executor child process per order.
 *
 * CRITICAL SECURITY CONTRACT (SPEC §4 #4, ADR-0023):
 *   - This function MUST NOT mutate process.env.
 *   - Signer keys are passed ONLY in the child's env block.
 *   - filterParentEnv() strips ALL `*SIGNER_KEY`-named vars from the
 *     parent env BEFORE merging child-only signer keys.
 *   - The signer-isolation E2E test (`tests/e2e/signer-isolation.spec.ts`)
 *     snapshots process.env BEFORE and AFTER spawn and asserts no signer
 *     keys appear in the worker process's env at any point.
 *
 * Flow:
 *   1. Filter parent env to strip signer-key vars.
 *   2. Merge in { SAFE_SIGNER_KEY, SQUADS_SIGNER_KEY } from signer file.
 *   3. Spawn `node <executorPath>` with the filtered child env.
 *   4. Write order JSON to child stdin and close it.
 *   5. Collect stdout + stderr; await exit.
 *   6. Parse receipt from stdout via parseExecutorReceipt().
 *   7. Return ExecutorResult.
 */
import { spawn } from 'node:child_process';
import { parseExecutorReceipt } from './receipt-parser.js';
import type { OrderInput, ExecutorResult } from './types.js';
import type { SignerEnv } from './signer-env-loader.js';

/** Pattern for signer-key env var names (strips on both sides of '='). */
const SIGNER_KEY_PATTERN = /SIGNER_KEY$/;

/**
 * Build a clean child env from the parent env by stripping ALL vars whose
 * name ends with `SIGNER_KEY`. This is the primary guard against accidental
 * key leakage from the parent process environment.
 *
 * @param parentEnv - The parent process environment (pass process.env).
 * @returns A new plain object with signer-key vars removed.
 */
export function filterParentEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (SIGNER_KEY_PATTERN.test(key)) continue; // strip signer keys
    if (value !== undefined) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/** Options for spawnExecutor(). */
export interface SpawnExecutorOptions {
  /** Absolute path to the executor Node.js binary. */
  executorPath: string;
  /** Signer keys loaded from secrets/signer.env. */
  signerEnv: SignerEnv;
  /**
   * Timeout in milliseconds before the child is killed.
   * Default: 120000 (2 minutes).
   */
  timeoutMs?: number;
}

/**
 * Spawn the executor child process for a single order.
 *
 * NEVER passes signer keys through process.env — they are injected ONLY
 * into the child's `env` option. The worker's own process.env is never
 * mutated.
 *
 * @param order - The order to execute.
 * @param opts - Executor path, signer keys, optional timeout.
 * @returns ExecutorResult with exit code, parsed receipt, stderr, and latency.
 */
export async function spawnExecutor(order: OrderInput, opts: SpawnExecutorOptions): Promise<ExecutorResult> {
  const { executorPath, signerEnv, timeoutMs = 120_000 } = opts;

  // Step 1 — Build child env: strip signer keys from parent, then add child-only keys.
  // NEVER mutate process.env itself. Build a fresh object.
  // Justified: spawnExecutor is the ONE place that must read process.env to filter it.
  // AppConfig is not available here; the full parent env is needed to forward
  // PATH, NODE_ENV, DATABASE_URL, etc. to the child process.
  const childEnv: Record<string, string> = {
    /* eslint-disable-next-line no-restricted-syntax -- reads parent env to FILTER it, never to mutate it (ADR-0023) */
    ...filterParentEnv(process.env),
    SAFE_SIGNER_KEY: signerEnv.SAFE_SIGNER_KEY,
    SQUADS_SIGNER_KEY: signerEnv.SQUADS_SIGNER_KEY,
  };

  const startMs = Date.now();

  return new Promise<ExecutorResult>((resolve) => {
    const child = spawn('node', [executorPath], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Step 2 — Write order JSON to stdin and close.
    const orderJson = JSON.stringify(order);
    child.stdin.write(orderJson + '\n');
    child.stdin.end();

    // Step 3 — Kill child on timeout.
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - startMs;
      const receipt = parseExecutorReceipt(stdout);
      resolve({ exitCode, receipt, stderr, latencyMs });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - startMs;
      resolve({
        exitCode: null,
        receipt: null,
        stderr: stderr + `\n[spawn-error] ${String(err)}`,
        latencyMs,
      });
    });
  });
}
