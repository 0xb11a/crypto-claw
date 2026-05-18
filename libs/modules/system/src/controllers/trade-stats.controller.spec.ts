import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradeStatsController } from './trade-stats.controller.js';
import type { SystemService } from '../system.service.js';

const mockSvc = {
  getTradeStats: vi.fn(),
} as unknown as SystemService;

describe('TradeStatsController', () => {
  let ctrl: TradeStatsController;

  beforeEach(() => {
    vi.clearAllMocks();
    ctrl = new TradeStatsController(mockSvc);
  });

  it('delegates to svc.getTradeStats with no args when query is empty', async () => {
    const resp = {
      total_trades: 0,
      wins: 0,
      losses: 0,
      avg_win_percent: null,
      avg_loss_percent: null,
      total_pnl_usd: null,
      best_trade_pnl: null,
      worst_trade_pnl: null,
      win_rate: 0,
      total_return_percent: 0,
      current_value: 0,
      initial_balance: 0,
      _mode: 'real' as const,
    };
    (mockSvc.getTradeStats as ReturnType<typeof vi.fn>).mockResolvedValue(resp);
    const result = await ctrl.getTradeStats({});
    expect(mockSvc.getTradeStats).toHaveBeenCalledWith(undefined, undefined);
    expect(result).toBe(resp);
  });

  it('delegates chain and mode to svc.getTradeStats', async () => {
    const resp = { total_trades: 5, wins: 3, losses: 2, _mode: 'paper' as const };
    (mockSvc.getTradeStats as ReturnType<typeof vi.fn>).mockResolvedValue(resp);
    const result = await ctrl.getTradeStats({ chain: 'base', mode: 'paper' });
    expect(mockSvc.getTradeStats).toHaveBeenCalledWith('base', 'paper');
    expect(result).toBe(resp);
  });

  it('passes all stat fields through unchanged', async () => {
    const resp = {
      total_trades: 10,
      wins: 7,
      losses: 3,
      avg_win_percent: 42.5,
      avg_loss_percent: -15.2,
      total_pnl_usd: 1500,
      best_trade_pnl: 800,
      worst_trade_pnl: -200,
      win_rate: 70,
      total_return_percent: 15.0,
      current_value: 11500,
      initial_balance: 10000,
      _mode: 'real' as const,
    };
    (mockSvc.getTradeStats as ReturnType<typeof vi.fn>).mockResolvedValue(resp);
    const result = await ctrl.getTradeStats({});
    // All 12 stat fields must be present (regression gate for snake→camel mapping)
    expect(result['total_trades']).toBe(10);
    expect(result['avg_win_percent']).toBe(42.5);
    expect(result['avg_loss_percent']).toBe(-15.2);
    expect(result['total_pnl_usd']).toBe(1500);
    expect(result['best_trade_pnl']).toBe(800);
    expect(result['worst_trade_pnl']).toBe(-200);
    expect(result['win_rate']).toBe(70);
    expect(result['total_return_percent']).toBe(15.0);
    expect(result['current_value']).toBe(11500);
    expect(result['initial_balance']).toBe(10000);
  });
});
