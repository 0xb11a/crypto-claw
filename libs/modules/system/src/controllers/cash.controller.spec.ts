import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CashController } from './cash.controller.js';
import type { SystemService } from '../system.service.js';

const mockSvc = {
  getAllCash: vi.fn(),
  getCashByChain: vi.fn(),
  setCash: vi.fn(),
  getGas: vi.fn(),
} as unknown as SystemService;

describe('CashController', () => {
  let ctrl: CashController;

  beforeEach(() => {
    vi.clearAllMocks();
    ctrl = new CashController(mockSvc);
  });

  it('getAllCash delegates to svc.getAllCash', async () => {
    (mockSvc.getAllCash as ReturnType<typeof vi.fn>).mockResolvedValue({ base: 500, total: 500 });
    const result = await ctrl.getAllCash();
    expect(result['base']).toBe(500);
    expect(result['total']).toBe(500);
  });

  it('getCashByChain delegates to svc.getCashByChain', async () => {
    (mockSvc.getCashByChain as ReturnType<typeof vi.fn>).mockResolvedValue({ chain: 'base', cash: 500 });
    const result = await ctrl.getCashByChain('base');
    expect(mockSvc.getCashByChain).toHaveBeenCalledWith('base');
    expect(result.cash).toBe(500);
  });

  it('setCash delegates to svc.setCash', async () => {
    const dto = { chain: 'base', amount: 500 };
    (mockSvc.setCash as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, chain: 'base', cash: 500 });
    const result = await ctrl.setCash(dto);
    expect(result.ok).toBe(true);
  });

  it('getGas delegates to svc.getGas', async () => {
    (mockSvc.getGas as ReturnType<typeof vi.fn>).mockResolvedValue({
      chain: 'base',
      symbol: 'ETH',
      balance: 0.1,
      price: 3000,
      value_usd: 300,
    });
    const result = await ctrl.getGas({ chain: 'base' });
    expect(mockSvc.getGas).toHaveBeenCalledWith('base');
    expect(result.symbol).toBe('ETH');
  });
});
