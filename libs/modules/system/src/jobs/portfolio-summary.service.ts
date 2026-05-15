/**
 * portfolio-summary.service.ts — Portfolio aggregation and formatting service.
 *
 * Ports the core portfolio aggregation logic from `scripts/portfolio-summary.js`
 * into a NestJS injectable service. Produces a typed `PortfolioReport` struct
 * and a formatted Telegram message string.
 *
 * Price lookup is delegated to `DexscreenerAdapter` (replaces inline fetch
 * in the legacy script — same DEXScreener API, same response parsing).
 *
 * Config reads (ADR-0026 — per-field):
 *   - `PAPER_MODE`    — selects paper vs real positions.
 *   - `ACTIVE_CHAINS` — for cash totalling (all chains when no filter).
 *
 * SPEC §4 #6 — no `process.env` reads.
 * DoD §I — bug-for-bug parity with `scripts/portfolio-summary.js:main()`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@cclaw/prisma';
import { DexscreenerAdapter } from '@cclaw/adapters-dexscreener';
import { SystemService } from '../system.service.js';
import { getPortfolioRules, getAllChains } from '@cclaw/chain';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PortfolioPositionDetail {
  id: string;
  symbol: string;
  address: string;
  chain: string;
  tier: string;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  value: number;
  pnlPercent: number;
  pnlUsd: number;
  stopLoss: number;
  status: string;
}

export interface PortfolioReport {
  status: 'ok' | 'empty';
  message?: string;
  summary?: {
    totalValue: number;
    totalDeposited: number;
    totalPnlPercent: number;
    totalPnlUsd: number;
    positionCount: number;
    cashBalance: number;
  };
  allocation?: {
    base: number;
    conviction: number;
    moonshot: number;
    cash: number;
  };
  allocationAlerts?: string[];
  positions?: PortfolioPositionDetail[];
  chain?: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Portfolio summary service — aggregates positions + prices + cash for the
 * daily Telegram report.
 *
 * Reads positions directly via PrismaService to avoid a circular package
 * dependency (@cclaw/positions → @cclaw/system → @cclaw/positions). This is
 * a deliberate, bounded exception to the repository pattern: the query is
 * read-only and limited to the reporting surface (open/partial_exit positions).
 * A P3-cleanup PR should revisit by extracting a shared PortfolioPositionsQuery
 * class into a separate package (e.g. @cclaw/portfolio).
 *
 * Price lookups use DexscreenerAdapter.
 */
@Injectable()
export class PortfolioSummaryService {
  private readonly logger = new Logger(PortfolioSummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemService: SystemService,
    private readonly dexscreener: DexscreenerAdapter,
    private readonly configService: ConfigService,
  ) {}

  /** Resolve PAPER_MODE. ADR-0026. */
  private get isPaperMode(): boolean {
    const raw = this.configService.get<string>('PAPER_MODE');
    return raw === 'true' || raw === '1';
  }

  /**
   * Build the portfolio report for the daily Telegram digest.
   *
   * @param chain - Optional chain filter. If absent, aggregates all chains.
   * @returns Typed PortfolioReport struct.
   */
  async buildReport(chain?: string): Promise<PortfolioReport> {
    const mode = this.isPaperMode ? 'paper' : 'real';
    const timestamp = new Date().toISOString();

    // Load positions directly via PrismaService (bounded read-only query;
    // avoids circular package dep with @cclaw/positions — see class docblock).
    const rawPositions =
      mode === 'paper'
        ? await this.prisma.paperPosition.findMany({
            where: {
              status: { in: ['open', 'partial_exit'] },
              ...(chain ? { chain } : {}),
            },
            orderBy: { createdAt: 'desc' },
          })
        : await this.prisma.position.findMany({
            where: {
              status: { in: ['open', 'partial_exit'] },
              ...(chain ? { chain } : {}),
            },
            orderBy: { createdAt: 'desc' },
          });

    // Map to a minimal shape (matching legacy db-query.js field names used by portfolio-summary.js).
    const openPositions = rawPositions.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      address: p.address,
      chain: p.chain,
      tier: p.tier,
      entry_price: p.entryPrice,
      quantity: p.quantity,
      status: p.status,
      stop_loss: p.stopLoss,
    }));

    // Load cash — per-chain or all-chains sum.
    let cash = 0;
    let totalDeposited = 0;
    const cashPrefix = mode === 'paper' ? 'paper_cash_' : 'cash_';
    const depositedPrefix = mode === 'paper' ? 'paper_initial_balance_' : 'total_deposited_';

    const chainsToSum = chain ? [chain] : getAllChains();
    for (const c of chainsToSum) {
      try {
        const cashRow = await this.systemService.getMeta(`${cashPrefix}${c}`);
        cash += parseFloat((cashRow.value as string | null) ?? '0') || 0;
        const depositedRow = await this.systemService.getMeta(`${depositedPrefix}${c}`);
        totalDeposited += parseFloat((depositedRow.value as string | null) ?? '0') || 0;
      } catch {
        // Missing cash key is not an error — defaults to 0.
      }
    }

    if (openPositions.length === 0 && cash === 0) {
      return {
        status: 'empty',
        message: 'Empty portfolio. Set up positions via db-query.js add-position or deposit cash via set-cash.',
        timestamp,
      };
    }

    // Fetch current prices.
    const addresses = openPositions.map((p) => p.address);
    const chainId = chain ?? 'base'; // fallback chain for DEXScreener query
    const priceMap = await this.dexscreener.getTokenPrices(addresses, chainId);

    let totalPositionValue = 0;
    const positionDetails: PortfolioPositionDetail[] = [];

    for (const pos of openPositions) {
      // Price fallback: use DEXScreener result or entry_price.
      const currentPrice = priceMap.get(pos.address.toLowerCase()) ?? priceMap.get(pos.address) ?? pos.entry_price;
      const quantity = pos.quantity;
      const value = currentPrice * quantity;
      const pnl = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;

      totalPositionValue += value;
      positionDetails.push({
        id: pos.id,
        symbol: pos.symbol,
        address: pos.address,
        chain: pos.chain,
        tier: pos.tier,
        entryPrice: pos.entry_price,
        currentPrice,
        quantity,
        value: parseFloat(value.toFixed(2)),
        pnlPercent: parseFloat(pnl.toFixed(2)),
        pnlUsd: parseFloat((value - pos.entry_price * quantity).toFixed(2)),
        stopLoss: pos.stop_loss,
        status: pos.status,
      });
    }

    const totalValue = totalPositionValue + cash;
    const totalPnl = totalDeposited > 0 ? ((totalValue - totalDeposited) / totalDeposited) * 100 : 0;

    // Calculate allocation by tier.
    const allocationUsd = { base: 0, conviction: 0, moonshot: 0, cash };
    for (const pos of positionDetails) {
      allocationUsd[pos.tier as keyof typeof allocationUsd] =
        (allocationUsd[pos.tier as keyof typeof allocationUsd] ?? 0) + pos.value;
    }

    const allocation = {
      base: totalValue > 0 ? parseFloat(((allocationUsd.base / totalValue) * 100).toFixed(1)) : 0,
      conviction: totalValue > 0 ? parseFloat(((allocationUsd.conviction / totalValue) * 100).toFixed(1)) : 0,
      moonshot: totalValue > 0 ? parseFloat(((allocationUsd.moonshot / totalValue) * 100).toFixed(1)) : 0,
      cash: totalValue > 0 ? parseFloat(((cash / totalValue) * 100).toFixed(1)) : 0,
    };

    // Allocation health check per chain.
    const allocationAlerts: string[] = [];
    const chainsToCheck = chain ? [chain] : [...new Set(positionDetails.map((p) => p.chain))];
    for (const c of chainsToCheck) {
      const rules = getPortfolioRules(c);
      const chainPositions = positionDetails.filter((p) => p.chain === c);
      const chainValue = chainPositions.reduce((sum, p) => sum + p.value, 0);
      const chainMoonshot = chainPositions.filter((p) => p.tier === 'moonshot').reduce((sum, p) => sum + p.value, 0);
      if (chainValue > 0) {
        const moonshotPct = (chainMoonshot / chainValue) * 100;
        if (moonshotPct > rules.maxMoonshotAllocation) {
          allocationAlerts.push(
            `[${c}] Moonshot allocation ${moonshotPct.toFixed(1)}% exceeds ${rules.maxMoonshotAllocation}% target`,
          );
        }
      }
      if (allocation.cash < rules.minCashReserve) {
        allocationAlerts.push(`[${c}] Cash reserve below ${rules.minCashReserve}% minimum`);
      }
    }

    const report: PortfolioReport = {
      status: 'ok',
      summary: {
        totalValue: parseFloat(totalValue.toFixed(2)),
        totalDeposited,
        totalPnlPercent: parseFloat(totalPnl.toFixed(2)),
        totalPnlUsd: parseFloat((totalValue - totalDeposited).toFixed(2)),
        positionCount: positionDetails.length,
        cashBalance: cash,
      },
      allocation,
      allocationAlerts,
      positions: positionDetails,
      timestamp,
    };
    if (chain) report.chain = chain;

    return report;
  }

  /**
   * Format a `PortfolioReport` as a Telegram HTML message string.
   *
   * Returns a compact summary suitable for a Telegram message.
   * Bug-for-bug parity with the legacy daily Telegram message format.
   */
  formatForTelegram(report: PortfolioReport): string {
    if (report.status === 'empty') {
      return `<b>Portfolio Daily Report</b>\n${report.message ?? 'Empty portfolio.'}\n<i>${report.timestamp}</i>`;
    }

    const { summary, allocation, allocationAlerts, positions, chain } = report;
    if (!summary || !allocation) {
      return `<b>Portfolio Daily Report</b>\nNo data available.\n<i>${report.timestamp}</i>`;
    }

    const chainLabel = chain ? ` [${chain}]` : '';
    const pnlSign = summary.totalPnlUsd >= 0 ? '+' : '';
    const lines: string[] = [
      `<b>Portfolio Daily Report${chainLabel}</b>`,
      `Total Value: <b>$${summary.totalValue.toLocaleString()}</b>`,
      `P&amp;L: ${pnlSign}$${summary.totalPnlUsd.toFixed(2)} (${pnlSign}${summary.totalPnlPercent.toFixed(2)}%)`,
      `Cash: $${summary.cashBalance.toFixed(2)} (${allocation.cash}%)`,
      `Positions: ${summary.positionCount}`,
      '',
      `Allocation: base=${allocation.base}% | conviction=${allocation.conviction}% | moonshot=${allocation.moonshot}% | cash=${allocation.cash}%`,
    ];

    if (allocationAlerts && allocationAlerts.length > 0) {
      lines.push('', '<b>Allocation Alerts:</b>');
      for (const alert of allocationAlerts) {
        lines.push(`  ⚠️ ${alert}`);
      }
    }

    if (positions && positions.length > 0) {
      lines.push('', '<b>Positions:</b>');
      for (const pos of positions) {
        const pnlSign2 = pos.pnlPercent >= 0 ? '+' : '';
        lines.push(
          `  ${pos.symbol} (${pos.chain}): $${pos.value.toFixed(2)} | ${pnlSign2}${pos.pnlPercent.toFixed(2)}%`,
        );
      }
    }

    lines.push('', `<i>${report.timestamp}</i>`);
    return lines.join('\n');
  }
}
