/**
 * executor-path.ts — Resolves the absolute path to the executor binary.
 *
 * SPEC §4 #4 — only apps/executor is allowed to run the signing logic.
 *
 * Resolution order:
 *   1. EXECUTOR_BIN_PATH env var (if set and non-empty)
 *   2. Fallback: <repo-root>/apps/executor/dist/main.js
 *
 * The fallback assumes the TypeScript monorepo's `pnpm build` has been run.
 * In production Docker, the image build copies the compiled output to the
 * same absolute path, so the fallback works in both dev and prod.
 */
import { resolve } from 'node:path';

/**
 * Returns the absolute path to `apps/executor/dist/main.js`.
 *
 * @param env - Environment record; reads EXECUTOR_BIN_PATH if present.
 * @returns Absolute path string.
 */
export function getExecutorPath(env: Record<string, string | undefined> = {}): string {
  const override = env['EXECUTOR_BIN_PATH'];
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  // __dirname is libs/execution/dist (after tsc build), resolve up 4 levels to repo root.
  // In dev (tsx / ts-node), __dirname is libs/execution/src — same depth.
  return resolve(__dirname, '../../../../apps/executor/dist/main.js');
}
