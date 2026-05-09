import { Module } from '@nestjs/common';
import { ConfigModule, assertConfigValid, assertNoSignerKeysInEnv } from '@cclaw/config';
import { LoggerModule } from '@cclaw/logger';

// Boot self-checks run at module-import time so they fire before NestFactory
// touches anything. Order matches main.ts (SPEC §4 #4 then §4 #6): signer-key
// isolation first, then config validation. Both are idempotent — main.ts
// re-runs them as a defensive double-check; the second call is a no-op if the
// first passed and never reached if the first throws.
assertNoSignerKeysInEnv(process.env);
const _config = assertConfigValid(process.env);

/**
 * Root application module for apps/api.
 *
 * P0: imports ConfigModule and LoggerModule only. No controllers, no
 * additional providers. Feature modules are added in P1+.
 *
 * Default-deny route walk (SPEC §4 #3) is deferred to P1 when the first
 * controller is introduced.
 */
@Module({
  imports: [ConfigModule, LoggerModule.forRoot({ logLevel: _config.LOG_LEVEL, nodeEnv: _config.NODE_ENV })],
})
export class AppModule {}
