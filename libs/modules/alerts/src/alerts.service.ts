import { Injectable } from '@nestjs/common';
import { AlertsRepository } from './alerts.repository.js';
import type { CreateAlertDto } from './dto/create-alert.dto.js';
import type { AcknowledgeAlertDto } from './dto/acknowledge-alert.dto.js';
import type { AlertListQueryDto } from './dto/alert-list-query.dto.js';
import type { AlertResponseDto, AlertListResponseDto } from './dto/alert-response.dto.js';
import type { SendAlertDto } from './dto/send-alert.dto.js';
import { NotificationsService } from '@cclaw/notifications';
import type { AlertType } from '@cclaw/notifications';

/**
 * Alerts service — domain logic for sentinel_alerts.
 *
 * Idempotent acknowledge: re-ack of an already-acked alert returns 200 with the
 * existing row (no 409). The `processedAt` timestamp from the first ack is preserved.
 */
@Injectable()
export class AlertsService {
  constructor(
    private readonly repo: AlertsRepository,
    private readonly notifications: NotificationsService,
  ) {}

  async list(query: AlertListQueryDto): Promise<AlertListResponseDto> {
    const limit = Math.min(query.limit ?? 50, 200);
    const [data, total] = await Promise.all([this.repo.findMany(query), this.repo.count(query)]);
    const lastId = data.length > 0 ? data[data.length - 1]?.id : undefined;
    return {
      data,
      pagination: { total, limit, cursor: lastId, hasMore: data.length === limit },
    };
  }

  async getById(id: string): Promise<AlertResponseDto> {
    return this.repo.findById(id);
  }

  async create(dto: CreateAlertDto): Promise<AlertResponseDto> {
    return this.repo.create(dto);
  }

  /**
   * Acknowledge an alert.
   *
   * Idempotent — calling this on an already-acknowledged alert returns 200 with
   * the existing row. The `processedAt` timestamp from the first ack is preserved.
   *
   * @param id - Alert ID to acknowledge
   * @param _dto - Optional note (accepted but not stored; reserved for future use)
   */
  async acknowledge(id: string, _dto: AcknowledgeAlertDto): Promise<AlertResponseDto> {
    return this.repo.acknowledge(id);
  }

  /**
   * Fire a Telegram notification via NotificationsService.
   *
   * Fire-and-forget: always returns `{ accepted: true }` even when
   * TELEGRAM_BOT_TOKEN is absent or Telegram is unreachable. The
   * NotificationsService.sendCriticalAlert() call swallows TelegramApiError
   * and TelegramBotTokenMissingError internally (logs a warn instead).
   *
   * No rate limiting, no per-type formatters — bug-for-bug parity with the
   * deleted `scripts/send-alert.js` (ADR-0028).
   *
   * @param dto - Validated SendAlertDto from POST /v1/alerts/send
   * @returns Always `{ accepted: true }` — delivery is async and best-effort
   */
  async send(dto: SendAlertDto): Promise<{ accepted: true }> {
    // Deliberately not awaited — fire-and-forget (ADR-0028 §4)
    void this.notifications.sendCriticalAlert({
      type: dto.type as AlertType,
      agent: dto.agent,
      message: dto.message,
    });
    return { accepted: true };
  }
}
