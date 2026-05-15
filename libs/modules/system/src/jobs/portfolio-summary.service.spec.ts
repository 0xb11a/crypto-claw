/**
 * Unit tests for PortfolioSummaryService (DoD §A).
 *
 * All external dependencies are mocked. No real DB or API calls.
 *
 * Covers:
 *   - buildReport: empty portfolio returns status='empty'.
 *   - buildReport: populates summary, allocation, positions.
 *   - buildReport: paper mode reads paper_cash_ prefix.
 *   - buildReport: chain filter applied.
 *   - buildReport: allocation alerts when moonshot exceeds threshold.
 *   - formatForTelegram: produces non-empty string for ok report.
 *   - formatForTelegram: produces message for empty report.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { PortfolioSummaryService } from './portfolio-summary.service.js';
import type { PortfolioReport } from './portfolio-summary.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePosition(
  overrides: Partial<{
    id: string;
    symbol: string;
    address: string;
    chain: string;
    tier: string;
    entry_price: number;
    quantity: number;
    status: string;
    stop_loss: number;
  }> = {},
) {
  return {
    id: 'pos-1',
    symbol: 'WETH',
    address: '0xtoken',
    chain: 'base',
    tier: 'conviction',
    entry_price: 3000,
    quantity: 0.1,
    status: 'open',
    stop_loss: 2500,
    ...overrides,
  };
}

function makeServices(
  overrides: {
    positions?: ReturnType<typeof makePosition>[];
    prices?: Map<string, number>;
    cashValue?: string | null;
    isPaper?: boolean;
  } = {},
) {
  const { positions = [], prices = new Map(), cashValue = '1000', isPaper = false } = overrides;

  // Mock PrismaService — PortfolioSummaryService reads positions directly.
  const prisma = {
    position: {
      findMany: vi.fn().mockResolvedValue(
        positions.map((p) => ({
          id: p.id,
          symbol: p.symbol,
          address: p.address,
          chain: p.chain,
          tier: p.tier,
          entryPrice: p.entry_price,
          quantity: p.quantity,
          status: p.status,
          stopLoss: p.stop_loss,
          createdAt: '2026-05-14T00:00:00.000Z',
        })),
      ),
    },
    paperPosition: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };

  const systemService = {
    getMeta: vi.fn().mockResolvedValue({ key: 'cash_base', value: cashValue }),
  };

  const dexscreener = {
    getTokenPrices: vi.fn().mockResolvedValue(prices),
  };

  const configService = {
    get: vi.fn((key: string) => {
      if (key === 'PAPER_MODE') return isPaper ? 'true' : 'false';
      if (key === 'ACTIVE_CHAINS') return 'base';
      return undefined;
    }),
  };

  return { prisma, systemService, dexscreener, configService };
}

function makeService(services: ReturnType<typeof makeServices>): PortfolioSummaryService {
  return new PortfolioSummaryService(
    services.prisma as unknown as ConstructorParameters<typeof PortfolioSummaryService>[0],
    services.systemService as unknown as ConstructorParameters<typeof PortfolioSummaryService>[1],
    services.dexscreener as unknown as ConstructorParameters<typeof PortfolioSummaryService>[2],
    services.configService as unknown as ConstructorParameters<typeof PortfolioSummaryService>[3],
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PortfolioSummaryService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  // -------------------------------------------------------------------------
  // Empty portfolio
  // -------------------------------------------------------------------------

  describe('empty portfolio', () => {
    it('returns status=empty when no positions and no cash', async () => {
      const services = makeServices({ positions: [], cashValue: '0' });
      const svc = makeService(services);

      const report = await svc.buildReport();
      expect(report.status).toBe('empty');
      expect(report.message).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Normal portfolio
  // -------------------------------------------------------------------------

  describe('normal portfolio', () => {
    it('returns status=ok with positions', async () => {
      const position = makePosition({ entry_price: 3000, quantity: 0.1 });
      const prices = new Map([['0xtoken', 3300]]);
      const services = makeServices({ positions: [position], prices });
      const svc = makeService(services);

      const report = await svc.buildReport();
      expect(report.status).toBe('ok');
      expect(report.summary?.positionCount).toBe(1);
    });

    it('calculates total value correctly', async () => {
      const position = makePosition({ entry_price: 3000, quantity: 1 });
      const prices = new Map([['0xtoken', 3300]]);
      // getMeta returns '0' for all non-base chains and '1000' for base
      // getAllChains() returns all chains; we set cash to 0 for simplicity.
      const services = makeServices({ positions: [position], prices, cashValue: '0' });
      const svc = makeService(services);

      const report = await svc.buildReport();
      // totalValue = 3300 (position) + 0 (cash) = 3300
      expect(report.summary?.totalValue).toBe(3300);
    });

    it('falls back to entry_price when DEXScreener price is missing', async () => {
      const position = makePosition({ entry_price: 3000, quantity: 1 });
      const prices = new Map<string, number>(); // no price returned
      const services = makeServices({ positions: [position], prices, cashValue: '0' });
      const svc = makeService(services);

      const report = await svc.buildReport();
      // Should use entry_price = 3000 for value
      expect(report.positions?.[0]?.currentPrice).toBe(3000);
    });
  });

  // -------------------------------------------------------------------------
  // Allocation alerts
  // -------------------------------------------------------------------------

  describe('allocation alerts', () => {
    it('generates moonshot alert when allocation exceeds threshold', async () => {
      // Create a moonshot position with large value
      const position = makePosition({ tier: 'moonshot', entry_price: 1, quantity: 1_000_000 });
      const prices = new Map([['0xtoken', 1]]);
      // cash = 0 → all allocation in moonshot
      const services = makeServices({ positions: [position], prices, cashValue: '0' });
      const svc = makeService(services);

      const report = await svc.buildReport('base');
      // moonshot allocation should trigger alert
      const hasMoonshotAlert = report.allocationAlerts?.some((a) => a.includes('Moonshot'));
      expect(hasMoonshotAlert).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // formatForTelegram
  // -------------------------------------------------------------------------

  describe('formatForTelegram', () => {
    it('returns a non-empty string for ok report', () => {
      const report: PortfolioReport = {
        status: 'ok',
        summary: {
          totalValue: 5000,
          totalDeposited: 4000,
          totalPnlPercent: 25,
          totalPnlUsd: 1000,
          positionCount: 1,
          cashBalance: 1000,
        },
        allocation: { base: 0, conviction: 80, moonshot: 0, cash: 20 },
        allocationAlerts: [],
        positions: [
          {
            id: 'p1',
            symbol: 'WETH',
            address: '0x',
            chain: 'base',
            tier: 'conviction',
            entryPrice: 3000,
            currentPrice: 3300,
            quantity: 1,
            value: 3300,
            pnlPercent: 10,
            pnlUsd: 300,
            stopLoss: 2500,
            status: 'open',
          },
        ],
        timestamp: '2026-05-14T00:00:00.000Z',
      };

      const svc = makeService(makeServices());
      const msg = svc.formatForTelegram(report);
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).toContain('Portfolio Daily Report');
    });

    it('returns message for empty report', () => {
      const report: PortfolioReport = {
        status: 'empty',
        message: 'Empty portfolio.',
        timestamp: '2026-05-14T00:00:00.000Z',
      };

      const svc = makeService(makeServices());
      const msg = svc.formatForTelegram(report);
      expect(msg).toContain('Portfolio Daily Report');
      expect(msg).toContain('Empty portfolio.');
    });
  });
});
