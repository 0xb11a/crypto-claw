import { Module } from '@nestjs/common';
import { AlertsController } from './alerts.controller.js';
import { AlertsService } from './alerts.service.js';
import { AlertsRepository } from './alerts.repository.js';

/**
 * Alerts module — wires controller, service, and repository for sentinel_alerts.
 *
 * PrismaModule is global, so PrismaService is injected automatically.
 * Import in AppModule.
 */
@Module({
  controllers: [AlertsController],
  providers: [AlertsService, AlertsRepository],
  exports: [AlertsService, AlertsRepository],
})
export class AlertsModule {}
