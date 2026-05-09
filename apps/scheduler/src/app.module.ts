import { Module } from '@nestjs/common';
import { ConfigModule, assertConfigValid } from '@cclaw/config';
import { LoggerModule } from '@cclaw/logger';

// Resolve config once at module definition time.
// assertConfigValid is cheap and idempotent — calling it here (in addition to
// main.ts) is intentional: it gives LoggerModule the validated config values
// without wiring a Nest provider token from @cclaw/config (deferred to P1).
// If the env is invalid this call will exit(78) before Nest bootstraps.
const _config = assertConfigValid(process.env);

/**
 * Root application module for apps/scheduler.
 *
 * P0: imports ConfigModule and LoggerModule only. No cron schedules
 * registered yet — those are added in P3+ (SPEC §8).
 */
@Module({
  imports: [ConfigModule, LoggerModule.forRoot({ logLevel: _config.LOG_LEVEL, nodeEnv: _config.NODE_ENV })],
})
export class AppModule {}
