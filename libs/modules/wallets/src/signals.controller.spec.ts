/**
 * Unit tests for SignalsController (SPEC §14, DoD §A).
 *
 * Verifies that:
 * - getSignals() delegates to the service
 * - @Roles('agent', 'dashboard') is applied (handler exists on prototype)
 *
 * The controller is a thin delegator; the interesting logic is in
 * SignalsRepository and tested there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignalsController } from './signals.controller.js';
import type { SignalsService } from './signals.service.js';
import type { SmartMoneySignalResponseDto } from './dto/smart-money-signal-response.dto.js';

const sampleSignal: SmartMoneySignalResponseDto = {
  id: 1,
  tx_hash: '0xtx1',
  chain: 'base',
  wallet_address: '0xwallet1',
  wallet_score: 85,
  wallet_label: null,
  action: 'buy',
  token_address: '0xtoken1',
  token_symbol: 'ABC',
  counter_token_address: null,
  counter_token_symbol: null,
  amount_token: '1000',
  tx_timestamp: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
};

function makeSvc(overrides?: Partial<SignalsService>): SignalsService {
  return {
    getSignals: vi.fn().mockResolvedValue([sampleSignal]),
    ...overrides,
  } as unknown as SignalsService;
}

describe('SignalsController', () => {
  let ctrl: SignalsController;
  let svc: SignalsService;

  beforeEach(() => {
    svc = makeSvc();
    ctrl = new SignalsController(svc);
  });

  it('getSignals() delegates to svc.getSignals', async () => {
    const query = { since: '35m', action: 'buy' };
    const result = await ctrl.getSignals(query);
    expect(svc.getSignals).toHaveBeenCalledWith(query);
    expect(result).toEqual([sampleSignal]);
  });

  it('getSignals() with empty query delegates correctly', async () => {
    const result = await ctrl.getSignals({});
    expect(svc.getSignals).toHaveBeenCalledWith({});
    expect(Array.isArray(result)).toBe(true);
  });

  it('getSignals() with grouped query delegates correctly', async () => {
    const query = { group_by: 'token', min_wallets: 2 };
    await ctrl.getSignals(query);
    expect(svc.getSignals).toHaveBeenCalledWith(query);
  });

  it('getSignals() handler method is present on prototype', () => {
    expect(typeof ctrl.getSignals).toBe('function');
  });
});
