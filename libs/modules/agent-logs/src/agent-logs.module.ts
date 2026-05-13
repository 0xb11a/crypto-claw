import { Module } from '@nestjs/common';
import { ResearchLogController } from './controllers/research-log.controller.js';
import { SentinelLogController } from './controllers/sentinel-log.controller.js';
import { ExecutorLogController } from './controllers/executor-log.controller.js';
import { ObserverLogController } from './controllers/observer-log.controller.js';
import { AgentLogsService } from './agent-logs.service.js';
import { AgentLogsRepository } from './agent-logs.repository.js';

/**
 * Agent logs module — single module for all four agent log tables per SPEC §7.
 *
 * Uses a single repository (AgentLogsRepository) with per-agent methods and a single
 * service (AgentLogsService) routing to the right per-table method. Each log table
 * gets its own sub-controller under /v1/logs/<agent>.
 *
 * PrismaModule and ConfigModule are global; no explicit imports needed.
 */
@Module({
  controllers: [ResearchLogController, SentinelLogController, ExecutorLogController, ObserverLogController],
  providers: [AgentLogsService, AgentLogsRepository],
  exports: [AgentLogsService],
})
export class AgentLogsModule {}
