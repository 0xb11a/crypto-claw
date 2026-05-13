import { Module } from '@nestjs/common';
import { HeartbeatController } from './heartbeat.controller.js';
import { HeartbeatService } from './heartbeat.service.js';
import { HeartbeatRepository } from './heartbeat.repository.js';
import { IdlenessService } from './idleness.service.js';

/**
 * Heartbeat module — wires controller, service, repository, and idleness service.
 *
 * PrismaModule and ConfigModule are global, injected automatically.
 * Import in AppModule.
 */
@Module({
  controllers: [HeartbeatController],
  providers: [HeartbeatService, HeartbeatRepository, IdlenessService],
  exports: [HeartbeatService, HeartbeatRepository, IdlenessService],
})
export class HeartbeatModule {}
