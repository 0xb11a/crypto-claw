import { Injectable } from '@nestjs/common';
import { WalletsRepository } from './wallets.repository.js';
import type { AddTrackedWalletDto } from './dto/add-tracked-wallet.dto.js';
import type { ProposeWalletDto } from './dto/propose-wallet.dto.js';
import type { UpdateWalletScoreDto } from './dto/update-wallet-score.dto.js';
import type { TrackedWalletsQueryDto } from './dto/tracked-wallets-query.dto.js';
import type { TrackedWalletResponseDto } from './dto/tracked-wallet-response.dto.js';

/**
 * Wallets service — thin delegation layer between the controller and the repository.
 *
 * score_breakdown is stored and returned as a raw JSON string; no auto-parsing
 * (bug-for-bug parity with db-query.js).
 */
@Injectable()
export class WalletsService {
  constructor(private readonly repo: WalletsRepository) {}

  list(query: TrackedWalletsQueryDto): Promise<TrackedWalletResponseDto[]> {
    return this.repo.findMany(query);
  }

  getOne(address: string, chain: string): Promise<TrackedWalletResponseDto> {
    return this.repo.findOne(address, chain);
  }

  add(dto: AddTrackedWalletDto): Promise<TrackedWalletResponseDto> {
    return this.repo.upsertWallet(dto);
  }

  propose(dto: ProposeWalletDto): Promise<{ ok: boolean; address: string; status: string; source: string }> {
    return this.repo.proposeWallet(dto);
  }

  listUnscored(limit?: number): Promise<TrackedWalletResponseDto[]> {
    return this.repo.findUnscored(limit);
  }

  updateScore(address: string, chain: string, dto: UpdateWalletScoreDto): Promise<TrackedWalletResponseDto> {
    return this.repo.updateScore(address, chain, dto);
  }

  remove(address: string, chain: string): Promise<{ ok: boolean }> {
    return this.repo.remove(address, chain);
  }
}
