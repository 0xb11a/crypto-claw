import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { getChain, getActiveChains, getAllChains, getPortfolioRules } from '@cclaw/chain';
import { SystemRepository } from './system.repository.js';
import type { SetMetaDto } from './dto/set-meta.dto.js';
import type { MetaResponseDto } from './dto/meta-response.dto.js';
import type { SetCashDto } from './dto/set-cash.dto.js';
import type { CashByChainDto } from './dto/cash-by-chain.dto.js';
import type { CashBreakdownDto } from './dto/cash-breakdown.dto.js';
import type { GasResponseDto } from './dto/gas-query.dto.js';
import type { SyncStatusQueryDto } from './dto/sync-status-query.dto.js';
import type { PortfolioSyncResponseDto } from './dto/portfolio-sync-response.dto.js';
import type { PortfolioResponseDto, PortfolioSingleChainResponseDto } from './dto/portfolio-response.dto.js';
import type { TradeStatsResponseDto } from './dto/trade-stats-response.dto.js';
import type { ChainsResponseDto } from './dto/chains-response.dto.js';
import type { ChainConfigResponseDto } from './dto/chain-config-response.dto.js';
import type {
  SyncPortfolioDto,
  SyncPortfolioEnqueuedResponseDto,
  SyncPortfolioPaperResponseDto,
} from './dto/sync-portfolio.dto.js';

/**
 * Queue name constant — mirrors POSITION_RECONCILE_QUEUE from @cclaw/positions.
 * Defined here to avoid a circular dependency:
 *   @cclaw/positions → @cclaw/system → @cclaw/positions would be circular.
 * The value MUST stay in sync with positions/jobs/queue-names.ts.
 */
export const SYNC_POSITION_RECONCILE_QUEUE = 'position-reconcile' as const;

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
    @InjectQueue(SYNC_POSITION_RECONCILE_QUEUE)
    private readonly reconcileQueue: Queue,
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

  // ---------------------------------------------------------------------------
  // Portfolio
  // ---------------------------------------------------------------------------

  /**
   * Returns a portfolio snapshot for the given mode.
   *
   * When `chain` is supplied → single-chain shape (PortfolioSingleChainResponseDto).
   * When `chain` is omitted → all-chains shape (PortfolioResponseDto).
   *
   * `modeOverride` is the ?mode= escape hatch; when absent, auto-routes by
   * PAPER_MODE config (ADR-0026).
   */
  async getPortfolio(
    chain?: string,
    modeOverride?: 'real' | 'paper',
  ): Promise<PortfolioResponseDto | PortfolioSingleChainResponseDto> {
    const effectiveMode = modeOverride ?? this.mode;
    if (chain) {
      const result = await this.repo.getPortfolioForChain(chain, effectiveMode);
      return { ...result, _mode: effectiveMode };
    }
    const result = await this.repo.getPortfolioAllChains(effectiveMode);
    return { ...result, _mode: effectiveMode };
  }

  // ---------------------------------------------------------------------------
  // Trade stats
  // ---------------------------------------------------------------------------

  /**
   * Returns aggregated trade statistics.
   *
   * `chain` is optional (undefined = all chains).
   * `modeOverride` is the ?mode= escape hatch; when absent, auto-routes by PAPER_MODE.
   */
  async getTradeStats(chain?: string, modeOverride?: 'real' | 'paper'): Promise<TradeStatsResponseDto> {
    const effectiveMode = modeOverride ?? this.mode;
    const result = await this.repo.getTradeStats(chain, effectiveMode);
    return { ...result, _mode: effectiveMode };
  }

  // ---------------------------------------------------------------------------
  // Chains
  // ---------------------------------------------------------------------------

  /**
   * Returns the list of active and all known chains.
   *
   * `active` reads ACTIVE_CHAINS via ConfigService (ADR-0026).
   * `all` reads from @cclaw/chain helpers.
   * No DB access.
   */
  getChains(): ChainsResponseDto {
    const activeRaw = this.configSvc.get<string>('ACTIVE_CHAINS') ?? '';
    // getActiveChains accepts a plain env-like record (ADR-0026 pattern for chain helper).
    const active = getActiveChains({ ACTIVE_CHAINS: activeRaw });
    return { active, all: getAllChains() };
  }

  /**
   * Returns the full chain configuration for the given chain name.
   *
   * Throws if the chain is unknown (getChain() throws Error).
   * No DB access.
   */
  getChainConfig(chainName: string): ChainConfigResponseDto {
    const cfg = getChain(chainName); // throws on unknown chain
    const rules = getPortfolioRules(chainName);
    return {
      name: cfg.name,
      type: cfg.type,
      chainId: cfg.chainId,
      dex: cfg.dex,
      nativeToken: cfg.nativeToken,
      wrappedNativeToken: cfg.wrappedNativeToken,
      cashToken: cfg.cashToken,
      baseTierTokens: cfg.baseTierTokens ?? [],
      stablecoins: cfg.stablecoins,
      rules,
    };
  }

  // ---------------------------------------------------------------------------
  // Sync portfolio (enqueue)
  // ---------------------------------------------------------------------------

  /**
   * Enqueues a position-reconcile BullMQ job for the given chain.
   *
   * Paper mode short-circuits (mirrors legacy line 2010-2011).
   * Real mode: enqueues PositionReconcileProcessor job; returns 202 + jobId.
   *
   * Idempotency: PositionReconcileProcessor itself is idempotent (DoD §E);
   * enqueuing twice with the same payload runs the reconcile twice but leaves
   * the DB in the same state after both runs (shouldAppendDriftMarker guards
   * duplicate drift note appends within the same UTC hour).
   */
  async enqueueSyncPortfolio(
    dto: SyncPortfolioDto,
  ): Promise<SyncPortfolioEnqueuedResponseDto | SyncPortfolioPaperResponseDto> {
    if (this.mode === 'paper') {
      return { ok: false, message: 'Portfolio sync skipped in paper mode — DB is sole source of truth' };
    }
    const trigger = dto.trigger ?? 'manual';
    const job = await this.reconcileQueue.add('sync-portfolio', { chain: dto.chain, trigger });
    return { ok: true, queued: true, jobId: String(job.id) };
  }
}
