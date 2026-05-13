/**
 * Unit tests for SignalsRepository (SPEC §14, DoD §A).
 *
 * Focuses on query-building logic, param validation, and injection-guard
 * (chain allowlist).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SignalsRepository } from './signals.repository.js';
import type { PrismaService } from '@cclaw/prisma';

const rawSignal = {
  id: 1,
  tx_hash: '0xtx1',
  chain: 'base',
  wallet_address: '0xwallet',
  wallet_score: 85,
  wallet_label: null,
  action: 'buy',
  token_address: '0xtoken',
  token_symbol: 'ABC',
  counter_token_address: null,
  counter_token_symbol: null,
  amount_token: '1000',
  tx_timestamp: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
};

function makePrisma(): PrismaService {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([rawSignal]),
  } as unknown as PrismaService;
}

describe('SignalsRepository', () => {
  let repo: SignalsRepository;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new SignalsRepository(prisma);
  });

  it('returns ungrouped signals by default', async () => {
    const result = await repo.getSignals({});
    expect(Array.isArray(result)).toBe(true);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalled();
  });

  it('calls $queryRawUnsafe for grouped query', async () => {
    await repo.getSignals({ group_by: 'token', min_wallets: 2 });
    const sql = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(sql).toContain('COUNT(*) AS signal_count');
    expect(sql).toContain('HAVING n_wallets >= 2');
  });

  it('includes action filter in WHERE when action is provided', async () => {
    await repo.getSignals({ action: 'buy' });
    const params = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    // params[0] is the SQL string, params[1..] are bind values
    expect(params).toContain('buy');
  });

  it('throws BadRequestException for invalid action', async () => {
    await expect(repo.getSignals({ action: 'invalid' as 'buy' | 'sell' })).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException for unknown chain', async () => {
    await expect(repo.getSignals({ chain: 'unknown-chain' })).rejects.toThrow(BadRequestException);
  });

  it('accepts valid chains', async () => {
    for (const chain of ['base', 'eth', 'solana']) {
      await expect(repo.getSignals({ chain })).resolves.toBeDefined();
    }
  });

  it('defaults to 35m window', async () => {
    await repo.getSignals({});
    const params = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    // First bind param is the sinceClause string
    expect(params[1]).toBe('-35 minutes');
  });

  it('parses hours correctly', async () => {
    await repo.getSignals({ since: '2h' });
    const params = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(params[1]).toBe('-2 hours');
  });

  it('parses days correctly', async () => {
    await repo.getSignals({ since: '1d' });
    const params = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(params[1]).toBe('-1 days');
  });

  it('includes tokens_in_positions subquery when flag is set', async () => {
    await repo.getSignals({ tokens_in_positions: true });
    const sql = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(sql).toContain('SELECT address, chain FROM positions');
  });
});
