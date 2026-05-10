'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
const vitest_1 = require('vitest');
const common_1 = require('@nestjs/common');
const positions_repository_js_1 = require('./positions.repository.js');
// Minimal stub for a Position row
const rawPosition = {
  id: 'pos-1',
  symbol: 'ETH',
  name: null,
  address: '0xabc',
  chain: 'base',
  tier: 'conviction',
  entryPrice: 2000,
  currentPrice: 2100,
  quantity: 0.5,
  valueUsd: 1050,
  percentOfPortfolio: 5,
  entryDate: '2026-01-01',
  stopLoss: 1600,
  takeProfitLevels: '[2500,3000,4000]',
  narrative: 'defi',
  status: 'open',
  notes: null,
  onchainBalance: null,
  lastSyncedAt: null,
  exitPrice: null,
  exitDate: null,
  pnlPercent: null,
  pnlUsd: null,
  exitReason: null,
  maxPriceSinceEntry: null,
  trailingStopPct: null,
  trailingStopActive: 0,
  tpLevelsHit: '[]',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const makePrisma = () => ({
  position: {
    findMany: vitest_1.vi.fn().mockResolvedValue([rawPosition]),
    findUnique: vitest_1.vi.fn().mockResolvedValue(rawPosition),
    create: vitest_1.vi.fn().mockResolvedValue(rawPosition),
    update: vitest_1.vi.fn().mockResolvedValue(rawPosition),
    delete: vitest_1.vi.fn().mockResolvedValue(undefined),
    count: vitest_1.vi.fn().mockResolvedValue(1),
  },
  paperPosition: {
    findMany: vitest_1.vi.fn().mockResolvedValue([]),
    findUnique: vitest_1.vi.fn().mockResolvedValue(null),
    create: vitest_1.vi.fn(),
    update: vitest_1.vi.fn(),
    delete: vitest_1.vi.fn(),
    count: vitest_1.vi.fn().mockResolvedValue(0),
  },
});
(0, vitest_1.describe)('PositionsRepository', () => {
  let repo;
  let prisma;
  (0, vitest_1.beforeEach)(() => {
    prisma = makePrisma();
    repo = new positions_repository_js_1.PositionsRepository(prisma);
  });
  (0, vitest_1.describe)('findMany()', () => {
    (0, vitest_1.it)('returns mapped positions with parsed JSON arrays', async () => {
      const rows = await repo.findMany({});
      (0, vitest_1.expect)(rows).toHaveLength(1);
      (0, vitest_1.expect)(rows[0].take_profit_levels).toEqual([2500, 3000, 4000]);
      (0, vitest_1.expect)(rows[0].tp_levels_hit).toEqual([]);
      (0, vitest_1.expect)(rows[0].mode).toBe('real');
    });
    (0, vitest_1.it)('queries paper_positions for mode=paper', async () => {
      await repo.findMany({ mode: 'paper' });
      (0, vitest_1.expect)(prisma.paperPosition.findMany).toHaveBeenCalled();
      (0, vitest_1.expect)(prisma.position.findMany).not.toHaveBeenCalled();
    });
  });
  (0, vitest_1.describe)('findById()', () => {
    (0, vitest_1.it)('returns a mapped position', async () => {
      const pos = await repo.findById('pos-1', 'real');
      (0, vitest_1.expect)(pos.id).toBe('pos-1');
      (0, vitest_1.expect)(pos.take_profit_levels).toEqual([2500, 3000, 4000]);
    });
    (0, vitest_1.it)('throws NotFoundException when position not found', async () => {
      prisma.position.findUnique.mockResolvedValue(null);
      await (0, vitest_1.expect)(repo.findById('bad-id', 'real')).rejects.toThrow(common_1.NotFoundException);
    });
    (0, vitest_1.it)('throws NotFoundException for missing paper position', async () => {
      await (0, vitest_1.expect)(repo.findById('bad-id', 'paper')).rejects.toThrow(common_1.NotFoundException);
    });
  });
  (0, vitest_1.describe)('JSON field handling', () => {
    (0, vitest_1.it)('parses malformed JSON gracefully as empty array', async () => {
      const badRow = { ...rawPosition, takeProfitLevels: 'not-json', tpLevelsHit: '{{}' };
      prisma.position.findUnique.mockResolvedValue(badRow);
      const pos = await repo.findById('pos-1', 'real');
      (0, vitest_1.expect)(pos.take_profit_levels).toEqual([]);
      (0, vitest_1.expect)(pos.tp_levels_hit).toEqual([]);
    });
    (0, vitest_1.it)('parses null JSON column as empty array', async () => {
      const nullRow = { ...rawPosition, takeProfitLevels: null, tpLevelsHit: null };
      prisma.position.findUnique.mockResolvedValue(nullRow);
      const pos = await repo.findById('pos-1', 'real');
      (0, vitest_1.expect)(pos.take_profit_levels).toEqual([]);
    });
  });
});
//# sourceMappingURL=positions.repository.spec.js.map
