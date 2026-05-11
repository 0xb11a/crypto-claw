import './preload.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { assertNoSignerKeysInEnv, assertConfigValid } from '@cclaw/config';
import { IdentityRegistry } from '@cclaw/auth';
import { AppModule } from './app.module.js';
import { registerSwaggerGuard } from './swagger-guard.js';

/**
 * Bootstrap the CryptoClaw API server.
 *
 * Boot sequence (SPEC §4):
 * 1. assertNoSignerKeysInEnv — exits non-zero if signer keys are present (ADR-0010)
 * 2. assertConfigValid — exits 78 (EX_CONFIG) if env is invalid (SPEC §4 #6)
 * 3. Create NestJS app with Fastify adapter
 * 4. Register Swagger UI auth hook BEFORE SwaggerModule.setup() (SPEC §11, ADR-0022)
 * 5. Swagger setup — /v1/docs (UI) + /v1/openapi.json (raw JSON)
 * 6. Apply global prefix, bind 127.0.0.1:7878 (ADR-0006)
 * 7. Log readiness
 */
async function bootstrap(): Promise<void> {
  // Step 1 — signer-key isolation check (SPEC §4 #4, ADR-0010)
  // process.env is allowed in apps/*/src/main.ts (config/bootstrap exception block)
  assertNoSignerKeysInEnv(process.env);

  // Step 2 — config validation (SPEC §4 #6)
  assertConfigValid(process.env);

  // Step 3 — create app
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });

  // Step 4 — Swagger UI auth hook (SPEC §11, ADR-0022).
  // Must run BEFORE SwaggerModule.setup() so the hook intercepts Swagger routes.
  // Resolve IdentityRegistry from the DI container (already built in AppModule → AuthModule).
  const registry = app.get(IdentityRegistry);
  const fastifyInstance = app.getHttpAdapter().getInstance();
  registerSwaggerGuard(fastifyInstance, registry);

  // Step 5 — Swagger (SPEC §11: /v1/docs + /v1/openapi.json, both behind agent auth via hook above)
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

  // Step 6 — global prefix + binding (ADR-0006: localhost-only)
  app.setGlobalPrefix('v1', {
    // Exclude health routes from /v1 prefix (they're top-level)
    exclude: ['healthz', 'readyz'],
  });

  // Handle SIGTERM gracefully
  process.on('SIGTERM', async () => {
    await app.close();
    process.exit(0);
  });

  // Step 7 — listen on 127.0.0.1 only (ADR-0006)
  await app.listen(7878, '127.0.0.1');

  // Log readiness — literal string checked in acceptance tests
  process.stdout.write('[boot] api ready on 127.0.0.1:7878 — config OK; signer keys absent\n');
}

bootstrap().catch((err: unknown) => {
  process.stderr.write(`[boot] api startup failed: ${String(err)}\n`);
  process.exit(1);
});
