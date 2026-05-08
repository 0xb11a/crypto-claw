import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { assertNoSignerKeysInEnv, assertConfigValid } from '@cclaw/config';
import { AppModule } from './app.module.js';

/**
 * Bootstrap the CryptoClaw API server.
 *
 * Boot sequence (SPEC §4):
 * 1. assertNoSignerKeysInEnv — exits non-zero if signer keys are present (ADR-0010)
 * 2. assertConfigValid — exits 78 (EX_CONFIG) if env is invalid (SPEC §4 #6)
 * 3. Create NestJS app with Fastify adapter
 * 4. Apply global prefix, bind 127.0.0.1:7878 (ADR-0006)
 * 5. Log readiness
 */
async function bootstrap(): Promise<void> {
  // Step 1 — signer-key isolation check (SPEC §4 #4, ADR-0010)
  assertNoSignerKeysInEnv(process.env);

  // Step 2 — config validation (SPEC §4 #6)
  assertConfigValid(process.env);

  // Step 3 — create app
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });

  // Step 4 — global prefix + binding (ADR-0006: localhost-only)
  app.setGlobalPrefix('v1');

  // Handle SIGTERM gracefully
  process.on('SIGTERM', async () => {
    await app.close();
    process.exit(0);
  });

  // Step 5 — listen on 127.0.0.1 only (ADR-0006)
  await app.listen(7878, '127.0.0.1');

  // Log readiness — literal string checked in acceptance tests
  process.stdout.write('[boot] api ready on 127.0.0.1:7878 — config OK; signer keys absent\n');
}

bootstrap().catch((err: unknown) => {
  process.stderr.write(`[boot] api startup failed: ${String(err)}\n`);
  process.exit(1);
});
