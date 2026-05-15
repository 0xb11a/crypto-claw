import { Injectable, NotFoundException } from '@nestjs/common';
import { PositionsRepository } from './positions.repository.js';
import type { CreatePositionDto } from './dto/create-position.dto.js';
import type { UpdatePositionDto } from './dto/update-position.dto.js';
import type { ClosePositionDto } from './dto/close-position.dto.js';
import type { PositionListQueryDto } from './dto/position-list-query.dto.js';
import type { PositionResponseDto, PositionListResponseDto } from './dto/position-response.dto.js';

/**
 * Positions service — domain logic layer.
 *
 * Services call repositories; they do not write Prisma queries directly.
 * Paper-mode routing is handled inside the repository; the service passes
 * mode through and handles domain-level errors.
 */
@Injectable()
export class PositionsService {
  constructor(private readonly repo: PositionsRepository) {}

  async list(query: PositionListQueryDto): Promise<PositionListResponseDto> {
    const limit = Math.min(query.limit ?? 50, 200);
    const [data, total] = await Promise.all([this.repo.findMany(query), this.repo.count(query)]);

    const lastId = data.length > 0 ? data[data.length - 1]?.id : undefined;
    return {
      data,
      pagination: {
        total,
        limit,
        cursor: lastId,
        hasMore: data.length === limit,
      },
    };
  }

  async getById(id: string, mode: 'real' | 'paper' = 'real'): Promise<PositionResponseDto> {
    return this.repo.findById(id, mode);
  }

  async create(dto: CreatePositionDto): Promise<PositionResponseDto> {
    return this.repo.create(dto);
  }

  async update(id: string, dto: UpdatePositionDto, mode: 'real' | 'paper' = 'real'): Promise<PositionResponseDto> {
    // Verify the position exists before patching (throws 404 if not)
    await this.repo.findById(id, mode);
    return this.repo.update(id, dto, mode);
  }

  async close(id: string, dto: ClosePositionDto, mode: 'real' | 'paper' = 'real'): Promise<PositionResponseDto> {
    const pos = await this.repo.findById(id, mode);
    if (pos.status === 'closed') {
      throw new NotFoundException(`Position ${id} is already closed`);
    }
    return this.repo.closePosition(id, dto, mode);
  }

  async delete(id: string, mode: 'real' | 'paper' = 'real'): Promise<void> {
    await this.repo.findById(id, mode); // throws 404 if not found
    await this.repo.delete(id, mode);
  }

  /**
   * Delete a draft real-mode position.
   *
   * Delegates to PositionsRepository.deleteDraft, which guards against
   * accidental deletion of non-draft positions. Used by MultisigTrackerProcessor
   * when a BUY transaction is rejected on-chain.
   *
   * @param id - Position ID.
   * @throws NotFoundException if position not found.
   * @throws Error if position is not in 'draft' status.
   */
  async deleteDraft(id: string): Promise<void> {
    return this.repo.deleteDraft(id);
  }

  // ---------------------------------------------------------------------------
  // Position-reconcile methods (P3g2 PR-E)
  // ---------------------------------------------------------------------------

  /**
   * Find all real-mode open or partial-exit positions.
   *
   * Used by PositionReconcileProcessor to enumerate positions for on-chain
   * balance comparison.
   *
   * @param filter - Optional chain or address filter.
   */
  async findOpenAndPartialExit(filter?: {
    chain?: string;
    address?: string;
  }): Promise<import('./dto/position-response.dto.js').PositionResponseDto[]> {
    return this.repo.findOpenAndPartialExit(filter);
  }

  /**
   * Append a drift marker to the notes field of a position.
   *
   * Used by PositionReconcileProcessor to record on-chain drift.
   *
   * @param id - Position ID.
   * @param marker - Drift marker string to append.
   */
  async appendNote(id: string, marker: string): Promise<void> {
    return this.repo.appendNote(id, marker);
  }
}
