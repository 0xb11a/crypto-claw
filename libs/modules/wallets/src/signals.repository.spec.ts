/**
 * Unit tests for SignalsRepository (SPEC §14, DoD §A).
 *
 * Focuses on query-building logic, param validation, and injection-guard
 * (chain allowlist).
 *
 * After commit 3 (P2 cleanup):
 * - Ungrouped path without tokens_in_positions: uses Prisma findMany (not $queryRawUnsafe)
 * - Grouped path: still uses $queryRawUnsafe (ROUND(AVG()) not in Prisma groupBy)
 * - tokens_in_positions path: still uses $queryRawUnsafe (SQL subquery required)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SignalsRepository } from './signals.repository.js';
import type { PrismaService } from '@cclaw/prisma';

// Raw signal as returned by $queryRawUnsafe (snake_case columns)
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

// Prisma findMany returns camelCase Prisma model fields
const prismaSignal = {
  id: 1,
  txHash: '0xtx1',
  chain: 'base',
  walletAddress: '0xwallet',
  walletScore: 85,
  walletLabel: null,
  action: 'buy',
  tokenAddress: '0xtoken',
  tokenSymbol: 'ABC',
  counterTokenAddress: null,
  counterTokenSymbol: null,
  amountToken: '1000',
  txTimestamp: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
};

function makePrisma(): PrismaService {
  const now = new Date().toISOString();
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([rawSignal]),
    smartMoneySignal: {
      findMany: vi.fn().mockResolvedValue([prismaSignal]),
      upsert: vi.fn().mockResolvedValue({ ...prismaSignal, createdAt: now }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as PrismaService;
}

describe('SignalsRepository', () => {
  let repo: SignalsRepository;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new SignalsRepository(prisma);
  });

  // ---------------------------------------------------------------------------
  // Ungrouped path — now uses Prisma findMany (not $queryRawUnsafe)
  // ---------------------------------------------------------------------------

  it('returns ungrouped signals via findMany by default', async () => {
    const result = await repo.getSignals({});
    expect(Array.isArray(result)).toBe(true);
    expect(prisma.smartMoneySignal.findMany).toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('ungrouped result maps camelCase Prisma fields to snake_case response', async () => {
    const result = (await repo.getSignals({})) as unknown as Record<string, unknown>[];
    expect(result.length).toBe(1);
    expect(result[0]!['tx_hash']).toBe('0xtx1');
    expect(result[0]!['wallet_address']).toBe('0xwallet');
    expect(result[0]!['token_address']).toBe('0xtoken');
    expect(result[0]!['created_at']).toBe('2026-01-01T00:00:00Z');
  });

  it('passes action filter to findMany where clause', async () => {
    await repo.getSignals({ action: 'buy' });
    const callArgs = (prisma.smartMoneySignal.findMany as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(callArgs[0]!.where['action']).toBe('buy');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
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

  // ---------------------------------------------------------------------------
  // tokens_in_positions path — still uses $queryRawUnsafe (SQL subquery)
  // ---------------------------------------------------------------------------

  it('uses $queryRawUnsafe when tokens_in_positions=true', async () => {
    await repo.getSignals({ tokens_in_positions: true });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalled();
    expect(prisma.smartMoneySignal.findMany).not.toHaveBeenCalled();
  });

  it('includes tokens_in_positions subquery when flag is set', async () => {
    await repo.getSignals({ tokens_in_positions: true });
    const sql = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(sql).toContain('SELECT address, chain FROM positions');
  });

  it('does NOT include tokens_in_positions subquery when flag is false (uses findMany)', async () => {
    await repo.getSignals({ tokens_in_positions: false });
    expect(prisma.smartMoneySignal.findMany).toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('does NOT include tokens_in_positions subquery when flag is undefined (uses findMany)', async () => {
    await repo.getSignals({ tokens_in_positions: undefined });
    expect(prisma.smartMoneySignal.findMany).toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Grouped path — still uses $queryRawUnsafe
  // ---------------------------------------------------------------------------

  it('calls $queryRawUnsafe for grouped query with parameterized HAVING', async () => {
    // min_wallets is now passed as a positional '?' param, not interpolated.
    await repo.getSignals({ group_by: 'token', min_wallets: 2 });
    const callArgs = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const sql = callArgs[0] as string;
    expect(sql).toContain('COUNT(*) AS signal_count');
    // SQL must use placeholder, not the literal value
    expect(sql).toContain('HAVING n_wallets >= ?');
    expect(sql).not.toContain('HAVING n_wallets >= 2');
    // The value must appear as a positional param
    expect(callArgs).toContain(2);
  });

  it('does NOT include HAVING clause when min_wallets=0', async () => {
    await repo.getSignals({ group_by: 'token', min_wallets: 0 });
    const sql = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(sql).not.toContain('HAVING');
  });

  it('includes HAVING clause when min_wallets is not provided (defaults to 0) — no HAVING', async () => {
    await repo.getSignals({ group_by: 'token' });
    const sql = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(sql).not.toContain('HAVING n_wallets');
  });

  // ---------------------------------------------------------------------------
  // since parsing
  // ---------------------------------------------------------------------------

  it('defaults to 35m window (findMany gets gte with recent ISO string)', async () => {
    const before = Date.now();
    await repo.getSignals({});
    const after = Date.now();
    const callArgs = (prisma.smartMoneySignal.findMany as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { where: { createdAt: { gte: string } } },
    ];
    // parseSinceDate returns an ISO-8601 string (String? column requires string comparisons)
    const gteStr = callArgs[0]!.where.createdAt.gte;
    expect(typeof gteStr).toBe('string');
    const gteMs = Date.parse(gteStr);
    // Should be ~35 minutes ago
    const expected = before - 35 * 60_000;
    expect(gteMs).toBeGreaterThanOrEqual(expected - 1000);
    expect(gteMs).toBeLessThanOrEqual(after);
  });

  it('grouped path: parses hours correctly into SQLite interval', async () => {
    await repo.getSignals({ group_by: 'token', since: '2h' });
    const params = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(params[1]).toBe('-2 hours');
  });

  it('grouped path: parses days correctly into SQLite interval', async () => {
    await repo.getSignals({ group_by: 'token', since: '1d' });
    const params = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(params[1]).toBe('-1 days');
  });

  it('grouped path: includes all action+chain filters in params when both are provided', async () => {
    await repo.getSignals({ group_by: 'token', action: 'sell', chain: 'solana' });
    const params = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(params).toContain('sell');
    expect(params).toContain('solana');
  });

  // ---------------------------------------------------------------------------
  // Adversarial: SQL injection probe on chain param (coder-flagged scenario 1)
  // ---------------------------------------------------------------------------

  it('rejects SQL injection payload in chain param with BadRequestException (allowlist guard)', async () => {
    const injectionPayload = '; DROP TABLE smart_money_signals; --';
    await expect(repo.getSignals({ chain: injectionPayload })).rejects.toThrow(BadRequestException);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.smartMoneySignal.findMany).not.toHaveBeenCalled();
  });

  it('rejects chain with SQL comment prefix via allowlist guard', async () => {
    await expect(repo.getSignals({ chain: 'base--injected' })).rejects.toThrow(BadRequestException);
  });

  it('rejects chain with SELECT keyword via allowlist guard', async () => {
    await expect(repo.getSignals({ chain: 'SELECT * FROM' })).rejects.toThrow(BadRequestException);
  });

  // ---------------------------------------------------------------------------
  // Adversarial: since=99999999m extreme value (coder-flagged scenario 2)
  // ---------------------------------------------------------------------------

  it('accepts since=99999999m without throwing (no 500) — findMany path', async () => {
    await expect(repo.getSignals({ since: '99999999m' })).resolves.toBeDefined();
    expect(prisma.smartMoneySignal.findMany).toHaveBeenCalled();
  });

  it('accepts since=9999d (large days value) without throwing', async () => {
    await expect(repo.getSignals({ since: '9999d' })).resolves.toBeDefined();
  });

  it('accepts since=999h (large hours value) without throwing', async () => {
    await expect(repo.getSignals({ since: '999h' })).resolves.toBeDefined();
  });

  it('rejects invalid action value with BadRequestException', async () => {
    await expect(repo.getSignals({ action: 'transfer' as 'buy' | 'sell' })).rejects.toThrow(BadRequestException);
  });

  // ---------------------------------------------------------------------------
  // insertSignal() — PR-C: INSERT OR IGNORE parity
  // ---------------------------------------------------------------------------

  describe('insertSignal() — PR-C (INSERT OR IGNORE parity)', () => {
    const signalInput = {
      tx_hash: '0xnewtx',
      action: 'buy' as const,
      token_address: '0xTokNew',
      token_symbol: 'NEW',
      counter_token_address: '0xUSDC',
      counter_token_symbol: 'USDC',
      amount_token: '500',
      tx_timestamp: '2026-05-14T00:00:00.000Z',
    };

    it('returns {inserted:true} when Prisma upsert creates a new row', async () => {
      const now = new Date().toISOString();
      const p = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([rawSignal]),
        smartMoneySignal: {
          findMany: vi.fn(),
          upsert: vi.fn().mockResolvedValue({ ...prismaSignal, txHash: '0xnewtx', createdAt: now }),
          deleteMany: vi.fn(),
        },
      } as unknown as PrismaService;
      const r = new SignalsRepository(p);

      const result = await r.insertSignal(signalInput, '0xwallet', 85, 'test-label', 'base');

      expect(result.inserted).toBe(true);
    });

    it('returns {inserted:false} when Prisma upsert hits the unique constraint (old createdAt)', async () => {
      // Use a timestamp 5 seconds in the past — the 1-second tolerance check
      // (Date.now() - createdMs < 1_000) will be false → inserted:false
      const old = new Date(Date.now() - 5_000).toISOString(); // 5 seconds ago
      const p = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([rawSignal]),
        smartMoneySignal: {
          findMany: vi.fn(),
          upsert: vi.fn().mockResolvedValue({ ...prismaSignal, txHash: '0xnewtx', createdAt: old }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      } as unknown as PrismaService;
      const r = new SignalsRepository(p);

      const result = await r.insertSignal(signalInput, '0xwallet', 85, 'label', 'base');

      expect(result.inserted).toBe(false);
    });

    it('calls prisma.smartMoneySignal.upsert with the correct unique key', async () => {
      const now = new Date().toISOString();
      const p = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([]),
        smartMoneySignal: {
          findMany: vi.fn(),
          upsert: vi.fn().mockResolvedValue({ ...prismaSignal, createdAt: now }),
          deleteMany: vi.fn(),
        },
      } as unknown as PrismaService;
      const r = new SignalsRepository(p);

      await r.insertSignal(signalInput, '0xwallet', null, null, 'base');

      const callArg = (p.smartMoneySignal.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        where: { txHash_walletAddress_action_tokenAddress: Record<string, string> };
        update: Record<string, never>;
        create: Record<string, unknown>;
      };

      // Unique key fields
      expect(callArg.where.txHash_walletAddress_action_tokenAddress.txHash).toBe('0xnewtx');
      expect(callArg.where.txHash_walletAddress_action_tokenAddress.walletAddress).toBe('0xwallet');
      expect(callArg.where.txHash_walletAddress_action_tokenAddress.action).toBe('buy');
      expect(callArg.where.txHash_walletAddress_action_tokenAddress.tokenAddress).toBe('0xTokNew');

      // Update block is empty (INSERT OR IGNORE semantics)
      expect(Object.keys(callArg.update)).toHaveLength(0);
    });

    it('create block includes all expected fields', async () => {
      const now = new Date().toISOString();
      const p = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([]),
        smartMoneySignal: {
          findMany: vi.fn(),
          upsert: vi.fn().mockResolvedValue({ ...prismaSignal, createdAt: now }),
          deleteMany: vi.fn(),
        },
      } as unknown as PrismaService;
      const r = new SignalsRepository(p);

      await r.insertSignal(signalInput, '0xwallet', 90, 'my-label', 'base');

      const callArg = (p.smartMoneySignal.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        create: Record<string, unknown>;
      };

      expect(callArg.create['chain']).toBe('base');
      expect(callArg.create['walletAddress']).toBe('0xwallet');
      expect(callArg.create['walletScore']).toBe(90);
      expect(callArg.create['walletLabel']).toBe('my-label');
      expect(callArg.create['action']).toBe('buy');
      expect(callArg.create['tokenAddress']).toBe('0xTokNew');
      expect(callArg.create['tokenSymbol']).toBe('NEW');
    });
  });

  // ---------------------------------------------------------------------------
  // pruneOlderThan() — PR-C: 24h retention
  // ---------------------------------------------------------------------------

  describe('pruneOlderThan() — PR-C (24h retention)', () => {
    it('calls prisma.smartMoneySignal.deleteMany with a cutoff ISO date', async () => {
      const before = Date.now();
      const p = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([]),
        smartMoneySignal: {
          findMany: vi.fn(),
          upsert: vi.fn(),
          deleteMany: vi.fn().mockResolvedValue({ count: 3 }),
        },
      } as unknown as PrismaService;
      const r = new SignalsRepository(p);

      await r.pruneOlderThan(24);
      const after = Date.now();

      const callArg = (p.smartMoneySignal.deleteMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        where: { createdAt: { lt: string } };
      };
      const cutoffMs = new Date(callArg.where.createdAt.lt).getTime();
      // Cutoff should be ~24 h ago
      const expected = before - 24 * 3_600_000;
      expect(cutoffMs).toBeGreaterThanOrEqual(expected - 1_000);
      expect(cutoffMs).toBeLessThanOrEqual(after - 24 * 3_600_000 + 1_000);
    });

    it('returns {deleted: N} matching the deleteMany count', async () => {
      const p = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([]),
        smartMoneySignal: {
          findMany: vi.fn(),
          upsert: vi.fn(),
          deleteMany: vi.fn().mockResolvedValue({ count: 7 }),
        },
      } as unknown as PrismaService;
      const r = new SignalsRepository(p);

      const result = await r.pruneOlderThan(24);

      expect(result.deleted).toBe(7);
    });

    it('returns {deleted:0} when no rows are old enough', async () => {
      const p = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([]),
        smartMoneySignal: {
          findMany: vi.fn(),
          upsert: vi.fn(),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      } as unknown as PrismaService;
      const r = new SignalsRepository(p);

      const result = await r.pruneOlderThan(24);

      expect(result.deleted).toBe(0);
    });

    it('uses the correct hours multiplier (48h prune uses 48 * 3_600_000)', async () => {
      const before = Date.now();
      const p = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([]),
        smartMoneySignal: {
          findMany: vi.fn(),
          upsert: vi.fn(),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      } as unknown as PrismaService;
      const r = new SignalsRepository(p);

      await r.pruneOlderThan(48);
      const after = Date.now();

      const callArg = (p.smartMoneySignal.deleteMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        where: { createdAt: { lt: string } };
      };
      const cutoffMs = new Date(callArg.where.createdAt.lt).getTime();
      const expected = before - 48 * 3_600_000;
      expect(cutoffMs).toBeGreaterThanOrEqual(expected - 1_000);
      expect(cutoffMs).toBeLessThanOrEqual(after - 48 * 3_600_000 + 1_000);
    });
  });
});
