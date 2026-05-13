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

  // ---------------------------------------------------------------------------
  // Adversarial: SQL injection probe on chain param (coder-flagged scenario 1)
  // ---------------------------------------------------------------------------

  it('rejects SQL injection payload in chain param with BadRequestException (allowlist guard)', async () => {
    // This exact string must NOT reach $queryRawUnsafe — the allowlist guard fires first.
    const injectionPayload = '; DROP TABLE smart_money_signals; --';
    await expect(repo.getSignals({ chain: injectionPayload })).rejects.toThrow(BadRequestException);
    // The unsafe query must never have been called
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects chain with SQL comment prefix via allowlist guard', async () => {
    await expect(repo.getSignals({ chain: 'base--injected' })).rejects.toThrow(BadRequestException);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects chain with SELECT keyword via allowlist guard', async () => {
    await expect(repo.getSignals({ chain: 'SELECT * FROM' })).rejects.toThrow(BadRequestException);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Adversarial: since=99999999m extreme value (coder-flagged scenario 2)
  // ---------------------------------------------------------------------------

  it('accepts since=99999999m without throwing (no 500)', async () => {
    // The DTO @Matches regex allows any Nm/Nh/Nd. Repository must not reject extreme numbers.
    await expect(repo.getSignals({ since: '99999999m' })).resolves.toBeDefined();
    const params = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    // Verify the since clause is formed correctly from the extreme value
    expect(params[1]).toBe('-99999999 minutes');
  });

  it('accepts since=9999d (large days value) without throwing', async () => {
    await expect(repo.getSignals({ since: '9999d' })).resolves.toBeDefined();
    const params = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(params[1]).toBe('-9999 days');
  });

  it('accepts since=999h (large hours value) without throwing', async () => {
    await expect(repo.getSignals({ since: '999h' })).resolves.toBeDefined();
    const params = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(params[1]).toBe('-999 hours');
  });

  // ---------------------------------------------------------------------------
  // Adversarial: tokens_in_positions coercion (coder-flagged scenario 3)
  // ---------------------------------------------------------------------------

  it('does NOT include tokens_in_positions subquery when flag is false', async () => {
    await repo.getSignals({ tokens_in_positions: false });
    const sql = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(sql).not.toContain('SELECT address, chain FROM positions');
  });

  it('does NOT include tokens_in_positions subquery when flag is undefined', async () => {
    await repo.getSignals({ tokens_in_positions: undefined });
    const sql = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(sql).not.toContain('SELECT address, chain FROM positions');
  });

  // ---------------------------------------------------------------------------
  // HAVING clause is omitted when min_wallets=0 (coverage gap)
  // ---------------------------------------------------------------------------

  it('does NOT include HAVING clause when min_wallets=0', async () => {
    await repo.getSignals({ group_by: 'token', min_wallets: 0 });
    const sql = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(sql).not.toContain('HAVING');
  });

  it('includes HAVING clause when min_wallets is not provided (defaults to 0) — no HAVING', async () => {
    await repo.getSignals({ group_by: 'token' });
    const sql = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    // min_wallets undefined → defaults to 0 in the service layer; havingClause is empty
    expect(sql).not.toContain('HAVING n_wallets');
  });

  it('includes all action+chain filters in params when both are provided', async () => {
    await repo.getSignals({ action: 'sell', chain: 'solana' });
    const params = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(params).toContain('sell');
    expect(params).toContain('solana');
  });

  it('rejects invalid action value with BadRequestException', async () => {
    // e.g. someone bypasses DTO validation and calls repo directly
    await expect(repo.getSignals({ action: 'transfer' as 'buy' | 'sell' })).rejects.toThrow(BadRequestException);
  });
});
