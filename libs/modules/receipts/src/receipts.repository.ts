import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
// Type-only imports — no runtime @prisma/client access outside libs/prisma.
// eslint-disable-next-line no-restricted-imports
import type { Receipt, PaperReceipt } from '@prisma/client';
import type { CreateReceiptDto } from './dto/create-receipt.dto.js';
import type { ReceiptListQueryDto } from './dto/receipt-list-query.dto.js';
import type { ReceiptResponseDto } from './dto/receipt-response.dto.js';
import { randomUUID } from 'node:crypto';

type Mode = 'real' | 'paper';

/**
 * Receipts repository — the only place Prisma queries for receipts live.
 *
 * Routes to `receipts` or `paper_receipts` based on `mode`.
 * Maps camelCase Prisma fields → snake_case response DTOs to match legacy
 * db-query.js output (shim-parity / ADR-0020).
 */
@Injectable()
export class ReceiptsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Mappers
  // ---------------------------------------------------------------------------

  private mapReceipt(row: Receipt): ReceiptResponseDto {
    return {
      id: row.id,
      order_id: row.orderId,
      action: row.action,
      symbol: row.symbol,
      address: row.address,
      chain: row.chain,
      status: row.status,
      amount: row.amount ?? undefined,
      quantity: row.quantity ?? undefined,
      expected_price: row.expectedPrice ?? undefined,
      executed_price: row.executedPrice ?? undefined,
      slippage: row.slippage ?? undefined,
      safe_tx_hash: row.safeTxHash ?? undefined,
      onchain_tx_hash: row.onchainTxHash ?? undefined,
      safe_nonce: row.safeNonce ?? undefined,
      signatures_collected: row.signaturesCollected ?? undefined,
      signatures_required: row.signaturesRequired ?? undefined,
      gas_used: row.gasUsed ?? undefined,
      error: row.error ?? undefined,
      notes: row.notes ?? undefined,
      position_id: row.positionId ?? undefined,
      created_at: row.createdAt ?? undefined,
      mode: 'real',
    };
  }

  private mapPaperReceipt(row: PaperReceipt): ReceiptResponseDto {
    return {
      id: row.id,
      order_id: row.orderId,
      action: row.action,
      symbol: row.symbol,
      address: row.address,
      chain: row.chain,
      // paper receipts have no status column — use 'executed' as the semantic default
      status: 'executed',
      amount: row.amount ?? undefined,
      quantity: row.quantity ?? undefined,
      proposed_price: row.proposedPrice,
      tier: row.tier ?? undefined,
      stop_loss: row.stopLoss ?? undefined,
      take_profit_levels: row.takeProfitLevels ?? undefined,
      reasoning: row.reasoning ?? undefined,
      pnl_percent: row.pnlPercent ?? undefined,
      pnl_usd: row.pnlUsd ?? undefined,
      created_at: row.createdAt ?? undefined,
      mode: 'paper',
    };
  }

  // ---------------------------------------------------------------------------
  // Query methods
  // ---------------------------------------------------------------------------

  async findMany(query: ReceiptListQueryDto): Promise<ReceiptResponseDto[]> {
    const mode = query.mode ?? 'real';
    const limit = Math.min(query.limit ?? 50, 200);

    if (mode === 'paper') {
      const rows = await this.prisma.paperReceipt.findMany({
        where: {
          ...(query.orderId ? { orderId: query.orderId } : {}),
          ...(query.cursor ? { id: { gt: query.cursor } } : {}),
          ...(query.since ? { createdAt: { gte: query.since } } : {}),
          ...(query.until ? { createdAt: { lte: query.until } } : {}),
        },
        take: limit,
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((r) => this.mapPaperReceipt(r));
    }

    const rows = await this.prisma.receipt.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.orderId ? { orderId: query.orderId } : {}),
        ...(query.cursor ? { id: { gt: query.cursor } } : {}),
        ...(query.since ? { createdAt: { gte: query.since } } : {}),
        ...(query.until ? { createdAt: { lte: query.until } } : {}),
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapReceipt(r));
  }

  async findById(id: string, mode: Mode = 'real'): Promise<ReceiptResponseDto> {
    if (mode === 'paper') {
      const row = await this.prisma.paperReceipt.findUnique({ where: { id } });
      if (!row) throw new NotFoundException(`Paper receipt ${id} not found`);
      return this.mapPaperReceipt(row);
    }
    const row = await this.prisma.receipt.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Receipt ${id} not found`);
    return this.mapReceipt(row);
  }

  async create(dto: CreateReceiptDto): Promise<ReceiptResponseDto> {
    const mode = dto.mode ?? 'real';
    const id = randomUUID();
    const now = new Date().toISOString();

    if (mode === 'paper') {
      // Validate required paper-only field
      if (dto.expected_price == null) {
        throw new Error('paper receipts require expected_price as proposed_price');
      }
      const row = await this.prisma.paperReceipt.create({
        data: {
          id,
          orderId: dto.order_id,
          action: dto.action,
          symbol: dto.symbol,
          address: dto.address,
          chain: dto.chain,
          proposedPrice: dto.expected_price,
          tier: undefined,
          quantity: dto.quantity,
          amount: dto.amount,
          stopLoss: undefined,
          takeProfitLevels: undefined,
          reasoning: dto.notes,
          createdAt: now,
        },
      });
      return this.mapPaperReceipt(row);
    }

    const row = await this.prisma.receipt.create({
      data: {
        id,
        orderId: dto.order_id,
        action: dto.action,
        symbol: dto.symbol,
        address: dto.address,
        chain: dto.chain,
        status: dto.status,
        amount: dto.amount,
        quantity: dto.quantity,
        expectedPrice: dto.expected_price,
        executedPrice: dto.executed_price,
        slippage: dto.slippage,
        safeTxHash: dto.safe_tx_hash,
        onchainTxHash: dto.onchain_tx_hash,
        safeNonce: dto.safe_nonce,
        signaturesCollected: dto.signatures_collected,
        signaturesRequired: dto.signatures_required,
        gasUsed: dto.gas_used,
        error: dto.error,
        notes: dto.notes,
        positionId: dto.position_id,
        createdAt: now,
      },
    });
    return this.mapReceipt(row);
  }

  async count(query: Omit<ReceiptListQueryDto, 'limit' | 'cursor'>): Promise<number> {
    const mode = query.mode ?? 'real';
    if (mode === 'paper') {
      return this.prisma.paperReceipt.count({
        where: {
          ...(query.orderId ? { orderId: query.orderId } : {}),
          ...(query.since ? { createdAt: { gte: query.since } } : {}),
          ...(query.until ? { createdAt: { lte: query.until } } : {}),
        },
      });
    }
    return this.prisma.receipt.count({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.orderId ? { orderId: query.orderId } : {}),
        ...(query.since ? { createdAt: { gte: query.since } } : {}),
        ...(query.until ? { createdAt: { lte: query.until } } : {}),
      },
    });
  }
}
