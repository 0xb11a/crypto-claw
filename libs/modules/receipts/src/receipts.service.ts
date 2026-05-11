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
}
