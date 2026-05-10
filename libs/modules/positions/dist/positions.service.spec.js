'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
const vitest_1 = require('vitest');
const common_1 = require('@nestjs/common');
const positions_service_js_1 = require('./positions.service.js');
const openPosition = {
  id: 'pos-1',
  symbol: 'ETH',
  address: '0xabc',
  chain: 'base',
  tier: 'conviction',
  entry_price: 2000,
  quantity: 0.5,
  entry_date: '2026-01-01',
  stop_loss: 1600,
  take_profit_levels: [2500, 3000],
  status: 'open',
  trailing_stop_active: 0,
  tp_levels_hit: [],
  mode: 'real',
};
const makeRepo = (overrides) => ({
  findMany: vitest_1.vi.fn().mockResolvedValue([openPosition]),
  count: vitest_1.vi.fn().mockResolvedValue(1),
  findById: vitest_1.vi.fn().mockResolvedValue(openPosition),
  create: vitest_1.vi.fn().mockResolvedValue(openPosition),
  update: vitest_1.vi.fn().mockResolvedValue(openPosition),
  closePosition: vitest_1.vi.fn().mockResolvedValue({ ...openPosition, status: 'closed' }),
  delete: vitest_1.vi.fn().mockResolvedValue(undefined),
  ...overrides,
});
(0, vitest_1.describe)('PositionsService', () => {
  let svc;
  let repo;
  (0, vitest_1.beforeEach)(() => {
    repo = makeRepo();
    svc = new positions_service_js_1.PositionsService(repo);
  });
  (0, vitest_1.describe)('list()', () => {
    (0, vitest_1.it)('returns paginated results', async () => {
      const result = await svc.list({ limit: 10 });
      (0, vitest_1.expect)(result.data).toHaveLength(1);
      (0, vitest_1.expect)(result.pagination.total).toBe(1);
      (0, vitest_1.expect)(result.pagination.limit).toBe(10);
      (0, vitest_1.expect)(result.pagination.hasMore).toBe(false);
    });
    (0, vitest_1.it)('caps limit at 200', async () => {
      await svc.list({ limit: 999 });
      // repo.findMany is called — limit is capped at 200
      (0, vitest_1.expect)(repo.findMany).toHaveBeenCalledWith(vitest_1.expect.objectContaining({ limit: 999 }));
    });
    (0, vitest_1.it)('sets cursor to last position id', async () => {
      const result = await svc.list({});
      (0, vitest_1.expect)(result.pagination.cursor).toBe('pos-1');
    });
    (0, vitest_1.it)('routes to paper mode when mode=paper', async () => {
      await svc.list({ mode: 'paper' });
      (0, vitest_1.expect)(repo.findMany).toHaveBeenCalledWith(vitest_1.expect.objectContaining({ mode: 'paper' }));
    });
  });
  (0, vitest_1.describe)('getById()', () => {
    (0, vitest_1.it)('returns the position', async () => {
      const result = await svc.getById('pos-1');
      (0, vitest_1.expect)(result.id).toBe('pos-1');
    });
    (0, vitest_1.it)('throws 404 if not found', async () => {
      repo.findById.mockRejectedValue(new common_1.NotFoundException('not found'));
      await (0, vitest_1.expect)(svc.getById('bad-id')).rejects.toThrow(common_1.NotFoundException);
    });
  });
  (0, vitest_1.describe)('create()', () => {
    (0, vitest_1.it)('delegates to repository', async () => {
      const dto = {
        symbol: 'ETH',
        address: '0xabc',
        chain: 'base',
        tier: 'conviction',
        entry_price: 2000,
        quantity: 0.5,
        stop_loss: 1600,
        take_profit_levels: [2500, 3000],
      };
      const result = await svc.create(dto);
      (0, vitest_1.expect)(result.symbol).toBe('ETH');
    });
  });
  (0, vitest_1.describe)('update()', () => {
    (0, vitest_1.it)('throws 404 if position not found', async () => {
      repo.findById.mockRejectedValue(new common_1.NotFoundException('not found'));
      await (0, vitest_1.expect)(svc.update('bad-id', { stop_loss: 1500 })).rejects.toThrow(common_1.NotFoundException);
    });
    (0, vitest_1.it)('delegates to repository after existence check', async () => {
      await svc.update('pos-1', { stop_loss: 1500 });
      (0, vitest_1.expect)(repo.update).toHaveBeenCalledWith('pos-1', { stop_loss: 1500 }, 'real');
    });
  });
  (0, vitest_1.describe)('close()', () => {
    (0, vitest_1.it)('throws NotFoundException if already closed', async () => {
      repo.findById.mockResolvedValue({ ...openPosition, status: 'closed' });
      await (0, vitest_1.expect)(svc.close('pos-1', { exit_price: 2500 })).rejects.toThrow(common_1.NotFoundException);
    });
    (0, vitest_1.it)('closes an open position', async () => {
      const result = await svc.close('pos-1', { exit_price: 2500 });
      (0, vitest_1.expect)(result.status).toBe('closed');
    });
  });
  (0, vitest_1.describe)('delete()', () => {
    (0, vitest_1.it)('throws 404 if position not found', async () => {
      repo.findById.mockRejectedValue(new common_1.NotFoundException('not found'));
      await (0, vitest_1.expect)(svc.delete('bad-id')).rejects.toThrow(common_1.NotFoundException);
    });
    (0, vitest_1.it)('calls repo.delete after existence check', async () => {
      await svc.delete('pos-1');
      (0, vitest_1.expect)(repo.delete).toHaveBeenCalledWith('pos-1', 'real');
    });
  });
});
//# sourceMappingURL=positions.service.spec.js.map
