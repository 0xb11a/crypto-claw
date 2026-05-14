import './preload.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { assertNoSignerKeysInEnv, assertConfigValid } from '@cclaw/config';
import { AppModule } from './app.module.js';

/**
 * Bootstrap the CryptoClaw scheduler process.
 *
 * The scheduler runs as a NestJS standalone application context (no HTTP).
 * It enqueues work onto Redis BullMQ queues on a cron schedule (SPEC §8).
 *
 * Boot sequence mirrors apps/api (SPEC §4):
 * 1. assertNoSignerKeysInEnv — signer-key isolation check (ADR-0010)
 * 2. assertConfigValid — config schema validation (SPEC §4 #6)
 * 3. Create standalone NestJS context
 * 4. Log readiness, stay alive until SIGTERM
 */
async function bootstrap(): Promise<void> {
  // Step 1 — signer-key isolation check (SPEC §4 #4, ADR-0010)
  assertNoSignerKeysInEnv(process.env);

  // Step 2 — config validation (SPEC §4 #6)
  assertConfigValid(process.env);

  // Step 3 — create standalone application context (no HTTP server)
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  // Step 4 — log readiness
  process.stdout.write('[boot] scheduler ready (wallet-harvest cron: 0 * * * *)\n');

  // Stay alive until SIGTERM
  process.on('SIGTERM', async () => {
    await app.close();
    process.exit(0);
  });
}

bootstrap().catch((err: unknown) => {
  process.stderr.write(`[boot] scheduler startup failed: ${String(err)}\n`);
  process.exit(1);
});
