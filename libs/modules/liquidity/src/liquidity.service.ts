import { Injectable } from '@nestjs/common';
import { LiquidityRepository } from './liquidity.repository.js';
import type { AddLiquiditySnapshotDto } from './dto/add-liquidity-snapshot.dto.js';
import type { LiquidityQueryDto } from './dto/liquidity-query.dto.js';
import type { LiquiditySnapshotResponseDto } from './dto/liquidity-snapshot-response.dto.js';

/**
 * Liquidity service — thin delegation layer between the controller and the repository.
 */
@Injectable()
export class LiquidityService {
  constructor(private readonly repo: LiquidityRepository) {}

  list(query: LiquidityQueryDto): Promise<LiquiditySnapshotResponseDto[]> {
    return this.repo.findMany(query);
  }

  add(dto: AddLiquiditySnapshotDto): Promise<{ ok: boolean }> {
    return this.repo.create(dto);
  }
}
