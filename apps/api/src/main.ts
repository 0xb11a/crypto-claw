import './preload.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { assertNoSignerKeysInEnv, assertConfigValid } from '@cclaw/config';
import { IdentityRegistry } from '@cclaw/auth';
import { AppModule } from './app.module.js';
import { registerSwaggerGuard } from './swagger-guard.js';
import { runPrismaMigrateDeploy } from './prisma-migrate.bootstrap.js';

/**
 * Bootstrap the CryptoClaw API server.
 *
 * Boot sequence (SPEC §4):
 * 1. assertNoSignerKeysInEnv — exits non-zero if signer keys are present (ADR-0010)
 * 2. assertConfigValid — exits 78 (EX_CONFIG) if env is invalid (SPEC §4 #6)
 * 3. runPrismaMigrateDeploy — apply pending Prisma migrations (idempotent, advisory-locked)
 * 4. Create NestJS app with Fastify adapter
 * 5. Register Swagger UI auth hook BEFORE SwaggerModule.setup() (SPEC §11, ADR-0022)
 * 6. Swagger setup — /v1/docs (UI) + /v1/openapi.json (raw JSON)
 * 7. Apply global prefix, bind 127.0.0.1:7878 (ADR-0006)
 * 8. Log readiness
 */
async function bootstrap(): Promise<void> {
  // Step 1 — signer-key isolation check (SPEC §4 #4, ADR-0010).
  // MUST run before runPrismaMigrateDeploy: the child process inherits process.env;
  // signer keys must be absent before any subprocess is spawned.
  // process.env is allowed in apps/*/src/main.ts (config/bootstrap exception block).
  assertNoSignerKeysInEnv(process.env);

  // Step 2 — config validation (SPEC §4 #6)
  assertConfigValid(process.env);

  // Step 3 — apply pending Prisma migrations (ADR-0002, ADR-0026).
  // Runs before NestFactory.create so the schema is guaranteed present before any
  // module initialises a PrismaService connection. Failure → non-zero exit (not 78).
  runPrismaMigrateDeploy(process.env);

  // Step 4 — create app
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });

  // Step 5 — Swagger UI auth hook (SPEC §11, ADR-0022).
  // Must run BEFORE SwaggerModule.setup() so the hook intercepts Swagger routes.
  // Resolve IdentityRegistry from the DI container (already built in AppModule → AuthModule).
  const registry = app.get(IdentityRegistry);
  const fastifyInstance = app.getHttpAdapter().getInstance();
  registerSwaggerGuard(fastifyInstance, registry);

  // Step 6 — Swagger (SPEC §11: /v1/docs + /v1/openapi.json, both behind agent auth via hook above)
  const swaggerConfig = new DocumentBuilder()
    .setTitle('CryptoClaw')
    .setDescription('CryptoClaw API — auto-generated from controllers + DTOs')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('v1/docs', app, document);

  // Also expose raw openapi.json at /v1/openapi.json
  app.getHttpAdapter().get('/v1/openapi.json', (_req: unknown, res: { send: (d: unknown) => void }) => {
    res.send(document);
  });

  // Step 7 — global prefix + binding (ADR-0006: localhost-only)
  app.setGlobalPrefix('v1', {
    // Exclude health routes from /v1 prefix (they're top-level)
    exclude: ['healthz', 'readyz'],
  });

  // Handle SIGTERM gracefully
  process.on('SIGTERM', async () => {
    await app.close();
    process.exit(0);
  });

  // Step 8 — listen on 127.0.0.1 only (ADR-0006)
  // PORT env var is accepted for test scenarios (e.g. parallel integration-test
  // instances via tests/integration/_spawn-api.ts).  Production deploys should
  // leave PORT unset so the default (7878) applies.
  // process.env access is allowed in apps/*/src/main.ts (bootstrap exception block).
  const port = parseInt(process.env['PORT'] ?? '7878', 10);
  await app.listen(port, '127.0.0.1');

  // Log readiness — literal string checked by _spawn-api.ts readiness detection
  process.stdout.write(`[boot] api ready on 127.0.0.1:${port} — config OK; signer keys absent\n`);
}

bootstrap().catch((err: unknown) => {
  process.stderr.write(`[boot] api startup failed: ${String(err)}\n`);
  process.exit(1);
});
