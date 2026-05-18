import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortfolioController } from './portfolio.controller.js';
import type { SystemService } from '../system.service.js';

const mockSvc = {
  getPortfolio: vi.fn(),
} as unknown as SystemService;

describe('PortfolioController', () => {
  let ctrl: PortfolioController;

  beforeEach(() => {
    vi.clearAllMocks();
    ctrl = new PortfolioController(mockSvc);
  });

  it('delegates to svc.getPortfolio with no args when query is empty', async () => {
    const resp = { safe_id: 'fund1', chains: {}, total_value: 0, _mode: 'real' };
    (mockSvc.getPortfolio as ReturnType<typeof vi.fn>).mockResolvedValue(resp);
    const result = await ctrl.getPortfolio({});
    expect(mockSvc.getPortfolio).toHaveBeenCalledWith(undefined, undefined);
    expect(result).toBe(resp);
  });

  it('delegates chain and mode to svc.getPortfolio', async () => {
    const resp = {
      safe_id: 'fund1',
      chain: 'base',
      cash: 0,
      total_deposited: 0,
      positions: [],
      total_value: 0,
      _mode: 'paper',
    };
    (mockSvc.getPortfolio as ReturnType<typeof vi.fn>).mockResolvedValue(resp);
    const result = await ctrl.getPortfolio({ chain: 'base', mode: 'paper' });
    expect(mockSvc.getPortfolio).toHaveBeenCalledWith('base', 'paper');
    expect(result).toBe(resp);
  });
});
