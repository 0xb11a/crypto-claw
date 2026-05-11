import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
// Type-only imports — no runtime @prisma/client access outside libs/prisma.
// eslint-disable-next-line no-restricted-imports
import type { SentinelAlert } from '@prisma/client';
import type { CreateAlertDto } from './dto/create-alert.dto.js';
import type { AlertListQueryDto } from './dto/alert-list-query.dto.js';
import type { AlertResponseDto } from './dto/alert-response.dto.js';
import { randomUUID } from 'node:crypto';

/**
 * Alerts repository — the only place Prisma queries for sentinel_alerts live.
 *
 * Maps camelCase Prisma fields → snake_case response DTOs to match legacy
 * db-query.js mark-alert-processed + get-alerts output (ADR-0020).
 */
@Injectable()
export class AlertsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private mapAlert(row: SentinelAlert): AlertResponseDto {
    return {
      id: row.id,
      symbol: row.symbol,
      chain: row.chain,
      alert_type: row.alertType,
      severity: row.severity,
      current_price: row.currentPrice ?? undefined,
      trigger_price: row.triggerPrice ?? undefined,
      details: row.details ?? undefined,
      action: row.action ?? undefined,
      sell_amount: row.sellAmount ?? undefined,
      processed: row.processed,
      processed_at: row.processedAt ?? undefined,
      created_at: row.createdAt ?? undefined,
    };
  }

  async findMany(query: AlertListQueryDto): Promise<AlertResponseDto[]> {
    const limit = Math.min(query.limit ?? 50, 200);
    const rows = await this.prisma.sentinelAlert.findMany({
      where: {
        ...(query.unprocessed ? { processed: 0 } : {}),
        ...(query.alertType ? { alertType: query.alertType } : {}),
        ...(query.chain ? { chain: query.chain } : {}),
        ...(query.cursor ? { id: { gt: query.cursor } } : {}),
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapAlert(r));
  }

  async findById(id: string): Promise<AlertResponseDto> {
    const row = await this.prisma.sentinelAlert.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Alert ${id} not found`);
    return this.mapAlert(row);
  }

  async create(dto: CreateAlertDto): Promise<AlertResponseDto> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const row = await this.prisma.sentinelAlert.create({
      data: {
        id,
        symbol: dto.symbol,
        chain: dto.chain,
        alertType: dto.alert_type,
        severity: dto.severity,
        currentPrice: dto.current_price,
        triggerPrice: dto.trigger_price,
        details: dto.details,
        action: dto.action,
        sellAmount: dto.sell_amount,
        processed: 0,
        createdAt: now,
      },
    });
    return this.mapAlert(row);
  }

  /**
   * Acknowledge an alert — idempotent (ADR plan: re-ack returns 200 with existing row).
   *
   * Sets `processed = 1`. The `processedAt` timestamp is only written on the FIRST
   * acknowledgment; subsequent acks preserve the original timestamp.
   */
  async acknowledge(id: string): Promise<AlertResponseDto> {
    const existing = await this.prisma.sentinelAlert.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Alert ${id} not found`);

    // Idempotent: if already acknowledged, return the existing row unchanged.
    if (existing.processed === 1) {
      return this.mapAlert(existing);
    }

    const now = new Date().toISOString();
    const row = await this.prisma.sentinelAlert.update({
      where: { id },
      data: {
        processed: 1,
        processedAt: now,
      },
    });
    return this.mapAlert(row);
  }

  async count(query: Omit<AlertListQueryDto, 'limit' | 'cursor'>): Promise<number> {
    return this.prisma.sentinelAlert.count({
      where: {
        ...(query.unprocessed ? { processed: 0 } : {}),
        ...(query.alertType ? { alertType: query.alertType } : {}),
        ...(query.chain ? { chain: query.chain } : {}),
      },
    });
  }
}
