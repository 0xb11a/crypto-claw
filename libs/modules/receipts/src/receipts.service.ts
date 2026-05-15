import { Injectable } from '@nestjs/common';
import { ReceiptsRepository } from './receipts.repository.js';
import type { CreateReceiptDto } from './dto/create-receipt.dto.js';
import type { ReceiptListQueryDto } from './dto/receipt-list-query.dto.js';
import type { ReceiptResponseDto, ReceiptListResponseDto } from './dto/receipt-response.dto.js';

/**
 * Receipts service — thin orchestration layer between controller and repository.
 *
 * Receipts are immutable records of executor actions (real or paper). The service
 * delegates list/get/create to the repository and builds the paginated response envelope.
 */
@Injectable()
export class ReceiptsService {
  constructor(private readonly repo: ReceiptsRepository) {}

  async list(query: ReceiptListQueryDto): Promise<ReceiptListResponseDto> {
    const limit = Math.min(query.limit ?? 50, 200);
    const [data, total] = await Promise.all([this.repo.findMany(query), this.repo.count(query)]);
    const lastId = data.length > 0 ? data[data.length - 1]?.id : undefined;
    return {
      data,
      pagination: { total, limit, cursor: lastId, hasMore: data.length === limit },
    };
  }

  async getById(id: string, mode: 'real' | 'paper' = 'real'): Promise<ReceiptResponseDto> {
    return this.repo.findById(id, mode);
  }

  async create(dto: CreateReceiptDto): Promise<ReceiptResponseDto> {
    return this.repo.create(dto);
  }

  // ---------------------------------------------------------------------------
  // Multisig-tracking methods (P3g2 PR-D)
  // ---------------------------------------------------------------------------

  /**
   * Find real-mode receipts in the given statuses that have a linked position.
   *
   * Used by MultisigTrackerProcessor to find pending Safe/Squads receipts.
   */
  async findByStatuses(statuses: string[]): Promise<ReceiptResponseDto[]> {
    return this.repo.findByStatuses(statuses);
  }

  /** Mark a receipt as executed with an optional on-chain tx hash. */
  async markExecuted(id: string, onchainTxHash: string | null): Promise<void> {
    return this.repo.markExecuted(id, onchainTxHash);
  }

  /** Mark a receipt as reverted (failed or orphaned). */
  async markReverted(id: string, error?: string): Promise<void> {
    return this.repo.markReverted(id, error);
  }

  /** Update receipt notes (used for reminder timestamps). */
  async updateNotes(id: string, notes: string): Promise<void> {
    return this.repo.updateNotes(id, notes);
  }
}
