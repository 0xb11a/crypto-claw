/**
 * build-sdk.ts — Generate typed SDK from sdk/generated/openapi.json.
 *
 * Invokes openapi-typescript-codegen against the generated OpenAPI spec
 * and writes the typed client into sdk/generated/. Then runs Prettier on
 * the generated TypeScript files so the committed output stays stable.
 *
 * Run: pnpm run build:sdk
 * CI: re-runs and git diff --exit-code sdk/generated/
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execFileSync as exec } from 'node:child_process';
import { generate } from 'openapi-typescript-codegen';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const INPUT_PATH = resolve(REPO_ROOT, 'sdk/generated/openapi.json');
const OUTPUT_DIR = resolve(REPO_ROOT, 'sdk/generated');

async function main(): Promise<void> {
  if (!existsSync(INPUT_PATH)) {
    process.stderr.write(`[build:sdk] openapi.json not found at ${INPUT_PATH}\n`);
    process.stderr.write('[build:sdk] Run pnpm run build:openapi first.\n');
    process.exit(1);
  }

  await generate({
    input: INPUT_PATH,
    output: OUTPUT_DIR,
    httpClient: 'fetch',
    clientName: 'CClawClient',
    useOptions: false,
    useUnionTypes: true,
  });

  // Format generated TypeScript files with Prettier so the committed output
  // matches what lint-staged would produce — preventing false-positive drift.
  try {
    // Use the glob pattern through the shell to expand wildcard
    exec(
      resolve(REPO_ROOT, 'node_modules/.bin/prettier'),
      ['--write', 'sdk/generated/**/*.ts'],
      {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    // If Prettier is not available, skip formatting
  }

  process.stdout.write(`[build:sdk] SDK generated at ${OUTPUT_DIR}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`[build:sdk] FAILED: ${String(err)}\n`);
  process.exit(1);
});
