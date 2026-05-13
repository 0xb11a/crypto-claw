/**
 * Unit tests for SignalsService (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignalsService } from './signals.service.js';
import type { SignalsRepository } from './signals.repository.js';
import type { SmartMoneySignalResponseDto } from './dto/smart-money-signal-response.dto.js';

const sampleSignal: SmartMoneySignalResponseDto = {
  id: 1,
  tx_hash: '0xtx1',
  chain: 'base',
  wallet_address: '0xwallet1',
  wallet_score: 85,
  wallet_label: 'Smart Whale',
  action: 'buy',
  token_address: '0xtoken1',
  token_symbol: 'ABC',
  counter_token_address: null,
  counter_token_symbol: null,
  amount_token: '1000',
  tx_timestamp: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
};

function makeRepo(overrides?: Partial<SignalsRepository>): SignalsRepository {
  return {
    getSignals: vi.fn().mockResolvedValue([sampleSignal]),
    ...overrides,
  } as unknown as SignalsRepository;
}

describe('SignalsService', () => {
  let svc: SignalsService;
  let repo: SignalsRepository;

  beforeEach(() => {
    repo = makeRepo();
    svc = new SignalsService(repo);
  });

  it('getSignals() delegates to repo.getSignals', async () => {
    const query = { since: '35m', action: 'buy' };
    const result = await svc.getSignals(query);
    expect(repo.getSignals).toHaveBeenCalledWith(query);
    expect(result).toEqual([sampleSignal]);
  });

  it('getSignals() with grouped query returns grouped response', async () => {
    const grouped = [
      {
        token_address: '0xtoken1',
        chain: 'base',
        token_symbol: 'ABC',
        signal_count: 3,
        n_wallets: 2,
        avg_score: 82.5,
        buys: 3,
        sells: 0,
        first_seen: '2026-01-01T00:00:00Z',
        last_seen: '2026-01-01T01:00:00Z',
      },
    ];
    const r = makeRepo({ getSignals: vi.fn().mockResolvedValue(grouped) });
    const s = new SignalsService(r);
    const result = await s.getSignals({ group_by: 'token', min_wallets: 2 });
    expect(Array.isArray(result)).toBe(true);
    expect((result[0] as (typeof grouped)[0]).n_wallets).toBe(2);
  });

  it('getSignals() passes default query to repo', async () => {
    await svc.getSignals({});
    expect(repo.getSignals).toHaveBeenCalledWith({});
  });
});
