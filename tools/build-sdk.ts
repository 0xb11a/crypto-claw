/**
 * build-sdk.ts — Generate typed SDK from sdk/generated/openapi.json.
 *
 * Invokes openapi-typescript-codegen against the generated OpenAPI spec
 * and writes the typed client into sdk/generated/.
 *
 * Run: pnpm run build:sdk
 * CI: re-runs and git diff --exit-code sdk/generated/
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { generate } from 'openapi-typescript-codegen';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const INPUT_PATH = resolve(__dirname, '../sdk/generated/openapi.json');
const OUTPUT_DIR = resolve(__dirname, '../sdk/generated');

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

  process.stdout.write(`[build:sdk] SDK generated at ${OUTPUT_DIR}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`[build:sdk] FAILED: ${String(err)}\n`);
  process.exit(1);
});
