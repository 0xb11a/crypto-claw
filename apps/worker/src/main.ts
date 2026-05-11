import './preload.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { existsSync, statSync } from 'node:fs';
import { assertNoSignerKeysInEnv, assertConfigValid } from '@cclaw/config';
import { AppModule } from './app.module.js';

/**
 * Bootstrap the CryptoClaw worker process.
 *
 * The worker runs as a NestJS standalone application context (no HTTP).
 * It processes BullMQ jobs enqueued by orders service and scheduler.
 *
 * Boot sequence (SPEC §4):
 * 1. assertNoSignerKeysInEnv — signer-key isolation check (ADR-0010)
 * 2. assertConfigValid — config schema validation (SPEC §4 #6)
 * 3. Check secrets/signer.env exists + mode 0400 (ADR-0023)
 * 4. Create standalone NestJS context
 * 5. Log readiness, stay alive until SIGTERM
 */
async function bootstrap(): Promise<void> {
  // Step 1 — signer-key isolation check (SPEC §4 #4, ADR-0010)
  assertNoSignerKeysInEnv(process.env);

  // Step 2 — config validation (SPEC §4 #6)
  const cfg = assertConfigValid(process.env);

  // Step 3 — signer env file check (ADR-0023)
  // The file may not exist in dev/test (executor won't be called until an order is executed).
  // Hard-fail only in production to avoid breaking local dev workflows.
  const signerEnvFile = cfg.SIGNER_ENV_FILE;
  if (!existsSync(signerEnvFile)) {
    const msg = `[boot] signer env file not found: ${signerEnvFile}`;
    if (cfg.NODE_ENV === 'production') {
      process.stderr.write(msg + ' — refusing to start in production without signer env file\n');
      process.exit(1);
    } else {
      process.stderr.write(`[WARN] ${msg} — proceeding in non-production mode (executor will fail at spawn)\n`);
    }
  } else {
    // Check mode in production (ADR-0023)
    const mode = statSync(signerEnvFile).mode & 0o777;
    const isWorldReadable = (mode & 0o007) !== 0;
    if (isWorldReadable && cfg.NODE_ENV === 'production') {
      process.stderr.write(
        `[boot] signer env file ${signerEnvFile} has insecure mode ${mode.toString(8)} — refusing to start\n`,
      );
      process.exit(1);
    }
  }

  // Step 4 — create standalone application context (no HTTP server)
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });

  // Step 5 — log readiness
  process.stdout.write('[boot] worker ready — execute-order processor active\n');

  // Stay alive until SIGTERM
  process.on('SIGTERM', async () => {
    await app.close();
    process.exit(0);
  });
}

bootstrap().catch((err: unknown) => {
  process.stderr.write(`[boot] worker startup failed: ${String(err)}\n`);
  process.exit(1);
});
