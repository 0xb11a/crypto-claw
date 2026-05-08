import { Module } from '@nestjs/common';
import { ConfigModule } from '@cclaw/config';
import { LoggerModule } from '@cclaw/logger';

/**
 * Root application module for apps/worker.
 *
 * P0: imports ConfigModule and LoggerModule only. No BullMQ processors
 * registered yet — those are added in P3+ (SPEC §8).
 */
@Module({
  imports: [ConfigModule, LoggerModule],
})
export class AppModule {}
