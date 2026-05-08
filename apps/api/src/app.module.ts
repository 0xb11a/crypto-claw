import { Module } from '@nestjs/common';
import { ConfigModule } from '@cclaw/config';
import { LoggerModule } from '@cclaw/logger';

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
  imports: [ConfigModule, LoggerModule],
})
export class AppModule {}
