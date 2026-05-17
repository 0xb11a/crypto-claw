import { Module } from '@nestjs/common';
import { AlertsController } from './alerts.controller.js';
import { AlertsService } from './alerts.service.js';
import { AlertsRepository } from './alerts.repository.js';
import { NotificationsModule } from '@cclaw/notifications';

/**
 * Alerts module — wires controller, service, and repository for sentinel_alerts.
 *
 * PrismaModule is global, so PrismaService is injected automatically.
 * NotificationsModule is imported to enable POST /v1/alerts/send (ADR-0028).
 * Import in AppModule.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [AlertsController],
  providers: [AlertsService, AlertsRepository],
  exports: [AlertsService, AlertsRepository],
})
export class AlertsModule {}
