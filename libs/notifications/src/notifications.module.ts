/**
 * NotificationsModule — wires TelegramAdapter and NotificationsService.
 *
 * Import in any NestJS module that needs Telegram alert delivery.
 * ConfigModule is global; no explicit import needed here.
 */
import { Module } from '@nestjs/common';
import { TelegramAdapter } from './telegram.adapter.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  providers: [TelegramAdapter, NotificationsService],
  exports: [TelegramAdapter, NotificationsService],
})
export class NotificationsModule {}
