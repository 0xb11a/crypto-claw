/**
 * build-openapi.ts — Generate sdk/generated/openapi.json from the Nest app.
 *
 * Boots the NestJS app (no listen), calls SwaggerModule.createDocument(),
 * and writes the result to sdk/generated/openapi.json with sorted keys for
 * diff stability.
 *
 * Run: pnpm run build:openapi
 * CI: re-runs and git diff --exit-code sdk/generated/openapi.json
 *
 * Note: This script loads the compiled dist artifacts (not source TypeScript)
 * to avoid ESM/CJS module boundary issues. Run `pnpm build` first.
 */

import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const OUTPUT_PATH = resolve(REPO_ROOT, 'sdk/generated/openapi.json');

// Use createRequire to load CommonJS modules from the compiled dist
// eslint-disable-next-line @typescript-eslint/no-require-imports
const req = createRequire(import.meta.url);

// Sort keys recursively for diff stability
function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return (obj as unknown[]).map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

async function main(): Promise<void> {
  // Load the NestJS framework
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { NestFactory } = req('@nestjs/core') as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { FastifyAdapter } = req('@nestjs/platform-fastify') as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { SwaggerModule, DocumentBuilder } = req('@nestjs/swagger') as any;

  // Load the compiled app module from dist
  const distPath = resolve(REPO_ROOT, 'apps/api/dist/app.module.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { AppModule } = req(distPath) as any;

  // Boot app without listening
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
    logger: false,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).setGlobalPrefix('v1', {
    exclude: ['healthz', 'readyz'],
  });

  const config = new DocumentBuilder()
    .setTitle('CryptoClaw')
    .setDescription('CryptoClaw API — auto-generated from controllers + DTOs')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const document = SwaggerModule.createDocument(app as any, config);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (app as any).close();

  // Write with sorted keys for diff stability
  const sorted = sortKeys(document);
  const json = JSON.stringify(sorted, null, 2);

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, json + '\n', 'utf8');

  const pathCount = Object.keys((document as { paths?: Record<string, unknown> }).paths ?? {}).length;
  process.stdout.write(`[build:openapi] Written ${OUTPUT_PATH}\n`);
  process.stdout.write(`[build:openapi] Paths: ${pathCount}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`[build:openapi] FAILED: ${String(err)}\n`);
  if (String(err).includes('dist/app.module.js')) {
    process.stderr.write('[build:openapi] Hint: Run `pnpm build` first to compile the app.\n');
  }
  process.exit(1);
});
