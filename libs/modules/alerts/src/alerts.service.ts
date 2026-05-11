import { Injectable } from '@nestjs/common';
import { AlertsRepository } from './alerts.repository.js';
import type { CreateAlertDto } from './dto/create-alert.dto.js';
import type { AcknowledgeAlertDto } from './dto/acknowledge-alert.dto.js';
import type { AlertListQueryDto } from './dto/alert-list-query.dto.js';
import type { AlertResponseDto, AlertListResponseDto } from './dto/alert-response.dto.js';

/**
 * Alerts service — domain logic for sentinel_alerts.
 *
 * Idempotent acknowledge: re-ack of an already-acked alert returns 200 with the
 * existing row (no 409). The `processedAt` timestamp from the first ack is preserved.
 */
@Injectable()
export class AlertsService {
  constructor(private readonly repo: AlertsRepository) {}

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
}
