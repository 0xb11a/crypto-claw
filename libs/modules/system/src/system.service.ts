import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemRepository } from './system.repository.js';
import type { SetMetaDto } from './dto/set-meta.dto.js';
import type { MetaResponseDto } from './dto/meta-response.dto.js';
import type { SetCashDto } from './dto/set-cash.dto.js';
import type { CashByChainDto } from './dto/cash-by-chain.dto.js';
import type { CashBreakdownDto } from './dto/cash-breakdown.dto.js';
import type { GasResponseDto } from './dto/gas-query.dto.js';
import type { SyncStatusQueryDto } from './dto/sync-status-query.dto.js';
import type { PortfolioSyncResponseDto } from './dto/portfolio-sync-response.dto.js';

/**
 * System service — thin orchestration layer for meta, cash, gas, and portfolio sync.
 *
 * Injects `_mode: 'paper' | 'real'` into non-array responses to match the legacy
 * db-query.js output() function which appended this field to every non-array object.
 * Required for byte-identical parity (ADR-0020).
 */
@Injectable()
export class SystemService implements OnApplicationBootstrap {
  constructor(
    private readonly repo: SystemRepository,
    private readonly configSvc: ConfigService,
  ) {}

  /**
   * Seed the `safe_id` portfolio_meta key at boot using the SAFE_ID env var.
   *
   * Legacy db.js migration 001 inserts `safe_id` dynamically via template
   * substitution. Prisma migrations cannot use env vars, so the seed is done
   * here at application bootstrap. Uses INSERT OR IGNORE semantics (upsert
   * with empty update) so repeated boots do not overwrite a value that was
   * changed after initial seed.
   */
  async onApplicationBootstrap(): Promise<void> {
    const safeId = this.configSvc.get<string>('SAFE_ID') ?? '';
    if (safeId) {
      await this.repo.seedSafeId(safeId);
    }
  }

  /**
   * Returns 'paper' when PAPER_MODE=true, 'real' otherwise.
   * ADR-0026: per-field get; normalise string 'true'/'false' to boolean.
   */
  private get mode(): 'real' | 'paper' {
    const raw = this.configSvc.get<string>('PAPER_MODE');
    return raw === 'true' || raw === '1' ? 'paper' : 'real';
  }

  async getMeta(key: string): Promise<MetaResponseDto> {
    const row = await this.repo.getMeta(key);
    return { ...row, _mode: this.mode };
  }

  setMeta(dto: SetMetaDto): Promise<{ ok: boolean; key: string; value: string }> {
    return this.repo.setMeta(dto);
  }

  async getCashByChain(chain: string): Promise<CashByChainDto> {
    const row = await this.repo.getCashByChain(chain);
    return { ...row, _mode: this.mode };
  }

  async getAllCash(): Promise<CashBreakdownDto> {
    const breakdown = await this.repo.getAllCash();
    return { ...breakdown, _mode: this.mode };
  }

  setCash(dto: SetCashDto): Promise<{ ok: boolean; chain: string; cash: number }> {
    return this.repo.setCash(dto);
  }

  getGas(chain: string): Promise<GasResponseDto> {
    return this.repo.getGas(chain);
  }

  getSyncStatus(query: SyncStatusQueryDto): Promise<PortfolioSyncResponseDto[]> {
    return this.repo.getSyncStatus(query);
  }
}
