/**
 * Integration tests for ActivityWalletsProcessor (SPEC §14, DoD §A, §E).
 *
 * Uses real Prisma against an isolated in-memory SQLite database named
 * `activity_test` (distinct from `harvest_test` and `score_wallets_test`
 * to avoid cross-spec interference in the same Vitest worker process).
 *
 * Mocks HeliusAdapter and EvmExplorerAdapter at the class boundary so no
 * HTTP calls are made. WalletsRepository, SignalsRepository, SystemRepository,
 * and SystemService run against the real Prisma client.
 *
 * Headline assertions (DoD §E — idempotency, per P3g1 plan §10):
 *   1. Idempotency triple-assert: 3 runs over identical fixtures;
 *      smart_money_signals row count + content byte-identical after run 2
 *      and run 3 (only last_activity_wallets_bg_at value changes).
 *   2. updateLastChecked fires on fetch failure: wallet's last_checked_at
 *      is updated to a recent ISO timestamp even when fetch throws.
 *   3. 24h prune: rows older than 24 h are deleted; fresh rows survive.
 *   4. INSERT OR IGNORE dedup: pre-seeded signal row is a conflict no-op.
 *
 * SPEC §8 — background job idempotency and rotation.
 * SPEC §14 — tests against real Prisma; mock at adapter boundary.
 * DoD §E — BullMQ processor: run twice, assert DB shape unchanged after second run.
 * DoD §I — INSERT OR IGNORE parity with legacy scripts/activity-wallets-bg.js.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Job } from 'bullmq';
import { PrismaService } from '@cclaw/prisma';
import { WalletsRepository } from '../wallets.repository.js';
import { SignalsRepository } from '../signals.repository.js';
import { SystemRepository } from '@cclaw/system';
import { SystemService } from '@cclaw/system';
import type { HeliusAdapter } from '@cclaw/adapters-helius';
import type { EvmExplorerAdapter } from '@cclaw/adapters-evm-explorer';
import { ActivityWalletsProcessor } from './activity-wallets.processor.js';

// ---------------------------------------------------------------------------
// In-process SQLite setup
// ---------------------------------------------------------------------------

let prisma: PrismaService;

beforeAll(async () => {
  // Named in-memory DB distinct from other integration specs
  process.env['DATABASE_URL'] = 'file::activity_test?mode=memory&cache=shared&connection_limit=1';
  process.env['PRISMA_DISABLE_DOTENV'] = '1';

  prisma = new PrismaService();
  await prisma.onModuleInit();

  // Create tables matching the Prisma schema (manual DDL for in-memory SQLite)
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "tracked_wallets" (
      "address"         TEXT NOT NULL,
      "chain"           TEXT NOT NULL,
      "label"           TEXT,
      "type"            TEXT,
      "notes"           TEXT,
      "status"          TEXT NOT NULL DEFAULT 'proposed',
      "score"           INTEGER,
      "score_breakdown" TEXT,
      "source_token"    TEXT,
      "scored_at"       TEXT,
      "score_error"     TEXT,
      "retry_count"     INTEGER NOT NULL DEFAULT 0,
      "source"          TEXT DEFAULT 'agent',
      "last_checked_at" TEXT,
      "created_at"      TEXT,
      PRIMARY KEY ("address", "chain")
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "smart_money_signals" (
      "id"                    INTEGER PRIMARY KEY AUTOINCREMENT,
      "tx_hash"               TEXT NOT NULL,
      "chain"                 TEXT NOT NULL,
      "wallet_address"        TEXT NOT NULL,
      "wallet_score"          INTEGER,
      "wallet_label"          TEXT,
      "action"                TEXT NOT NULL,
      "token_address"         TEXT NOT NULL,
      "token_symbol"          TEXT,
      "counter_token_address" TEXT,
      "counter_token_symbol"  TEXT,
      "amount_token"          TEXT,
      "tx_timestamp"          TEXT NOT NULL,
      "created_at"            TEXT,
      UNIQUE("tx_hash", "wallet_address", "action", "token_address")
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "portfolio_meta" (
      "key"        TEXT NOT NULL PRIMARY KEY,
      "value"      TEXT NOT NULL,
      "updated_at" TEXT
    )
  `);
}, 15_000);

afterAll(async () => {
  await prisma.onModuleDestroy();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(overrides: Record<string, unknown> = {}): {
  get: (k: string) => unknown;
} {
  const defaults: Record<string, unknown> = {
    WALLET_ACTIVITY_PER_FETCH_TIMEOUT_MS: 10_000,
    WALLET_ACTIVITY_PER_CHAIN_TIMEOUT_LIMIT: 5,
    WALLET_ACTIVITY_INTER_WALLET_DELAY_MS: 0, // no delay in integration tests
    ...overrides,
  };
  return { get: (k: string) => defaults[k] };
}

function makeJob(id = 'int-test'): Job {
  return { id, data: {} } as unknown as Job;
}

/** Snapshot smart_money_signals for deterministic diffing. */
async function snapshotSignals(): Promise<
  Array<{
    tx_hash: string;
    chain: string;
    wallet_address: string;
    action: string;
    token_address: string;
    token_symbol: string | null;
    amount_token: string | null;
    tx_timestamp: string | null;
  }>
> {
  const rows = await prisma.smartMoneySignal.findMany({
    orderBy: [{ txHash: 'asc' }, { walletAddress: 'asc' }, { action: 'asc' }],
  });
  return rows.map((r) => ({
    tx_hash: r.txHash,
    chain: r.chain,
    wallet_address: r.walletAddress,
    action: r.action,
    token_address: r.tokenAddress,
    token_symbol: r.tokenSymbol,
    amount_token: r.amountToken,
    tx_timestamp: r.txTimestamp,
  }));
}

async function getMetaValue(key: string): Promise<string | null> {
  const row = await prisma.portfolioMeta.findUnique({ where: { key } });
  return row?.value ?? null;
}

// ---------------------------------------------------------------------------
// Wire up services and adapters per test
// ---------------------------------------------------------------------------

let walletsRepo: WalletsRepository;
let signalsRepo: SignalsRepository;
let systemSvc: SystemService;

beforeEach(async () => {
  // Clear all rows between tests
  await prisma.smartMoneySignal.deleteMany({});
  await prisma.trackedWallet.deleteMany({});
  await prisma.portfolioMeta.deleteMany({});

  walletsRepo = new WalletsRepository(prisma);
  signalsRepo = new SignalsRepository(prisma);
  const systemRepo = new SystemRepository(prisma);
  const cfg = makeConfigService();
  const mockQueue = { add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }) } as unknown as import('bullmq').Queue;
  systemSvc = new SystemService(systemRepo, cfg as unknown as import('@nestjs/config').ConfigService, mockQueue);

  vi.spyOn(console, 'log').mockImplementation(() => {});
});

function buildProcessor(helius: HeliusAdapter, evmExplorer: EvmExplorerAdapter): ActivityWalletsProcessor {
  const cfg = makeConfigService();
  return new ActivityWalletsProcessor(
    helius,
    evmExplorer,
    walletsRepo,
    signalsRepo,
    systemSvc,
    cfg as unknown as import('@nestjs/config').ConfigService,
  );
}

/** Seed a smart_money scored wallet into the DB. */
async function seedWallet(address: string, chain: string, lastCheckedAt: string | null = null): Promise<void> {
  await prisma.trackedWallet.create({
    data: {
      address,
      chain,
      type: 'smart_money',
      status: 'scored',
      retryCount: 0,
      source: 'birdeye-harvest',
      lastCheckedAt: lastCheckedAt,
      createdAt: new Date().toISOString(),
    },
  });
}

/** Build a mock EvmExplorerAdapter that returns swap fixtures for any wallet. */
function makeEvmAdapterWithSwaps(swapRows: import('@cclaw/adapters-evm-explorer').EvmTokenTxRow[]): EvmExplorerAdapter {
  return {
    getTokenTx: vi.fn().mockResolvedValue(swapRows),
  } as unknown as EvmExplorerAdapter;
}

function makeHeliusAdapterEmpty(): HeliusAdapter {
  return { getParsedTransactions: vi.fn().mockResolvedValue([]) } as unknown as HeliusAdapter;
}

// EVM fixture: one BUY swap (USDC → TOKEN_A)
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TOKEN_A = '0xTokenA000000000000000000000000000000000a';
const WALLET = '0xWalletIntTest111';

const EVM_SWAP_ROWS: import('@cclaw/adapters-evm-explorer').EvmTokenTxRow[] = [
  {
    hash: '0xtxFixtureA',
    from: WALLET,
    to: '0xDEX',
    contractAddress: USDC_BASE,
    tokenSymbol: 'USDC',
    tokenName: 'USD Coin',
    value: '1000000',
    timeStamp: '1700000000',
  },
  {
    hash: '0xtxFixtureA',
    from: '0xDEX',
    to: WALLET,
    contractAddress: TOKEN_A,
    tokenSymbol: 'TKNA',
    tokenName: 'TokenA',
    value: '500',
    timeStamp: '1700000000',
  },
];

// ---------------------------------------------------------------------------
// Headline: Idempotency triple-assert (DoD §E)
// ---------------------------------------------------------------------------

describe('Idempotency (DoD §E — triple-assert)', () => {
  it('smart_money_signals row count + content byte-identical after run 2 and run 3', async () => {
    await seedWallet(WALLET, 'base');

    const evmAdapter = makeEvmAdapterWithSwaps(EVM_SWAP_ROWS);
    const proc = buildProcessor(makeHeliusAdapterEmpty(), evmAdapter);

    // Run 1: inserts the signal row
    await proc.process(makeJob('r1'));

    // Snapshot after run 1
    const snap1 = await snapshotSignals();
    expect(snap1).toHaveLength(1);

    // Run 2: signal already exists → INSERT OR IGNORE → no new row
    await proc.process(makeJob('r2'));
    const snap2 = await snapshotSignals();

    // Run 3: same
    await proc.process(makeJob('r3'));
    const snap3 = await snapshotSignals();

    // snap2 and snap3 must be byte-identical to snap1
    expect(snap2).toEqual(snap1);
    expect(snap3).toEqual(snap1);
  });

  it('only last_activity_wallets_bg_at advances across idempotent runs', async () => {
    await seedWallet(WALLET, 'base');
    const evmAdapter = makeEvmAdapterWithSwaps(EVM_SWAP_ROWS);
    const proc = buildProcessor(makeHeliusAdapterEmpty(), evmAdapter);

    await proc.process(makeJob('r1'));
    const meta1 = await getMetaValue('last_activity_wallets_bg_at');

    await new Promise((r) => setTimeout(r, 5));

    await proc.process(makeJob('r2'));
    const meta2 = await getMetaValue('last_activity_wallets_bg_at');

    // Wallet rows unchanged
    const wallets = await prisma.trackedWallet.count();
    expect(wallets).toBe(1);

    // Meta advanced
    expect(meta1).not.toBeNull();
    expect(meta2).not.toBeNull();
    expect(new Date(meta2!).getTime()).toBeGreaterThanOrEqual(new Date(meta1!).getTime());
  });

  it('row count does NOT grow across three runs (no duplicates)', async () => {
    await seedWallet(WALLET, 'base');
    const evmAdapter = makeEvmAdapterWithSwaps(EVM_SWAP_ROWS);
    const proc = buildProcessor(makeHeliusAdapterEmpty(), evmAdapter);

    for (const id of ['r1', 'r2', 'r3']) {
      await proc.process(makeJob(id));
    }

    const count = await prisma.smartMoneySignal.count();
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// updateLastChecked fires on failure
// ---------------------------------------------------------------------------

describe('updateLastChecked on failure (DoD §E rotation guarantee)', () => {
  it("wallet's last_checked_at is updated even when fetch throws", async () => {
    await seedWallet('0xFailWallet', 'base');

    const errAdapter = {
      getTokenTx: vi.fn().mockRejectedValue(new Error('network error')),
    } as unknown as EvmExplorerAdapter;
    const proc = buildProcessor(makeHeliusAdapterEmpty(), errAdapter);

    const beforeTs = Date.now();
    await proc.process(makeJob());
    const afterTs = Date.now();

    const row = await prisma.trackedWallet.findUnique({
      where: { address_chain: { address: '0xFailWallet', chain: 'base' } },
    });
    expect(row?.lastCheckedAt).not.toBeNull();
    const ts = new Date(row!.lastCheckedAt!).getTime();
    expect(ts).toBeGreaterThanOrEqual(beforeTs);
    expect(ts).toBeLessThanOrEqual(afterTs + 100);
  });
});

// ---------------------------------------------------------------------------
// 24h prune: removes only rows older than 24 h
// ---------------------------------------------------------------------------

describe('24h prune (DoD §E retention)', () => {
  it('deletes rows older than 24h and preserves fresh rows', async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString(); // 25 h ago

    // Seed 3 old rows and 2 fresh rows
    for (let i = 0; i < 3; i++) {
      await prisma.smartMoneySignal.create({
        data: {
          txHash: `0xold${i}`,
          chain: 'base',
          walletAddress: '0xOldWallet',
          action: 'buy',
          tokenAddress: `0xTokenOld${i}`,
          txTimestamp: old,
          createdAt: old,
        },
      });
    }
    for (let j = 0; j < 2; j++) {
      await prisma.smartMoneySignal.create({
        data: {
          txHash: `0xfresh${j}`,
          chain: 'base',
          walletAddress: '0xFreshWallet',
          action: 'buy',
          tokenAddress: `0xTokenFresh${j}`,
          txTimestamp: now,
          createdAt: now,
        },
      });
    }

    // No candidates → only prune runs
    const proc = buildProcessor(makeHeliusAdapterEmpty(), {
      getTokenTx: vi.fn().mockResolvedValue([]),
    } as unknown as EvmExplorerAdapter);

    await proc.process(makeJob());

    const remaining = await prisma.smartMoneySignal.count();
    // 3 old deleted, 2 fresh remain
    expect(remaining).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// INSERT OR IGNORE dedup: pre-seeded signal is a conflict no-op
// ---------------------------------------------------------------------------

describe('INSERT OR IGNORE dedup (DoD §I parity)', () => {
  it('pre-seeded signal row is a conflict no-op; row count grows by exactly N-1', async () => {
    await seedWallet(WALLET, 'base');

    // Pre-seed the signal that the fixture will also try to insert
    const seedTs = new Date().toISOString();
    await prisma.smartMoneySignal.create({
      data: {
        txHash: '0xtxFixtureA',
        chain: 'base',
        walletAddress: WALLET,
        action: 'buy',
        tokenAddress: TOKEN_A,
        txTimestamp: seedTs,
        createdAt: seedTs,
      },
    });

    const countBefore = await prisma.smartMoneySignal.count();
    expect(countBefore).toBe(1);

    const evmAdapter = makeEvmAdapterWithSwaps(EVM_SWAP_ROWS);
    const proc = buildProcessor(makeHeliusAdapterEmpty(), evmAdapter);

    await proc.process(makeJob());

    const countAfter = await prisma.smartMoneySignal.count();
    // EVM_SWAP_ROWS produces 1 signal, already seeded → count stays at 1 (no new rows)
    expect(countAfter).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rotation: wallets ordered by lastCheckedAt ASC NULLS FIRST
// ---------------------------------------------------------------------------

describe('Rotation: findActivityCandidates ordering', () => {
  it('null lastCheckedAt wallets are returned before wallets with timestamps', async () => {
    const tsOld = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const tsNew = new Date(Date.now() - 30_000).toISOString();

    // Insert in reverse order: the wallet with latest timestamp first
    await seedWallet('0xLatest', 'base', tsNew);
    await seedWallet('0xNull', 'base', null);
    await seedWallet('0xOldest', 'base', tsOld);

    const candidates = await walletsRepo.findActivityCandidates(10);

    // null comes first (NULLS FIRST)
    expect(candidates[0]!.address).toBe('0xNull');
    // oldest timestamp next
    expect(candidates[1]!.address).toBe('0xOldest');
    // latest timestamp last
    expect(candidates[2]!.address).toBe('0xLatest');
  });

  it('only smart_money scored wallets are returned (not whale or lowtier)', async () => {
    // whale and lowtier wallets must be excluded
    await prisma.trackedWallet.createMany({
      data: [
        { address: '0xSmartMoney', chain: 'base', type: 'smart_money', status: 'scored', retryCount: 0 },
        { address: '0xWhale', chain: 'base', type: 'whale', status: 'scored', retryCount: 0 },
        { address: '0xLowTier', chain: 'base', type: 'lowtier', status: 'scored', retryCount: 0 },
        { address: '0xProposed', chain: 'base', type: 'smart_money', status: 'proposed', retryCount: 0 },
      ],
    });

    const candidates = await walletsRepo.findActivityCandidates(10);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.address).toBe('0xSmartMoney');
  });

  it('LIMIT is respected', async () => {
    // Insert 5 smart_money wallets
    for (let i = 0; i < 5; i++) {
      await seedWallet(`0xLimitTest${i}`, 'base');
    }

    const candidates = await walletsRepo.findActivityCandidates(3);
    expect(candidates).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// updateLastChecked: write + read-back
// ---------------------------------------------------------------------------

describe('updateLastChecked: write and read-back', () => {
  it('writes timestamp and read-back matches the written ISO string', async () => {
    await seedWallet('0xReadback', 'base');
    const ts = '2026-05-14T12:00:00.000Z';

    await walletsRepo.updateLastChecked('0xReadback', 'base', ts);

    const row = await prisma.trackedWallet.findUnique({
      where: { address_chain: { address: '0xReadback', chain: 'base' } },
    });
    expect(row?.lastCheckedAt).toBe(ts);
  });
});

// ---------------------------------------------------------------------------
// signalsRepo.insertSignal + pruneOlderThan (integration-level)
// ---------------------------------------------------------------------------

describe('SignalsRepository.insertSignal (integration)', () => {
  it('returns {inserted:true} on first insert and deduplicates (count stays at 1) on duplicate', async () => {
    const input = {
      tx_hash: '0xinsertTest',
      action: 'buy' as const,
      token_address: '0xTok1',
      token_symbol: 'TOK',
      counter_token_address: '0xUSDC',
      counter_token_symbol: 'USDC',
      amount_token: '100',
      tx_timestamp: '2026-01-01T00:00:00.000Z',
    };

    const r1 = await signalsRepo.insertSignal(input, '0xWallet', null, null, 'base');
    expect(r1.inserted).toBe(true);

    // Insert the same signal again (duplicate unique key)
    await signalsRepo.insertSignal(input, '0xWallet', null, null, 'base');

    // Regardless of the inserted flag (timing-based), the count must stay at 1
    const count = await prisma.smartMoneySignal.count();
    expect(count).toBe(1);
  });
});

describe('SignalsRepository.pruneOlderThan (integration)', () => {
  it('returns {deleted: N} and removes exactly N old rows, leaving fresh ones', async () => {
    const now = new Date().toISOString();
    const oldTs = new Date(Date.now() - 25 * 3_600_000).toISOString();

    // 3 old rows
    for (let i = 0; i < 3; i++) {
      await prisma.smartMoneySignal.create({
        data: {
          txHash: `0xprune${i}`,
          chain: 'base',
          walletAddress: '0xW',
          action: 'buy',
          tokenAddress: `0xT${i}`,
          txTimestamp: oldTs,
          createdAt: oldTs,
        },
      });
    }
    // 2 fresh rows
    for (let j = 0; j < 2; j++) {
      await prisma.smartMoneySignal.create({
        data: {
          txHash: `0xfresh${j}`,
          chain: 'base',
          walletAddress: '0xW',
          action: 'sell',
          tokenAddress: `0xFT${j}`,
          txTimestamp: now,
          createdAt: now,
        },
      });
    }

    const result = await signalsRepo.pruneOlderThan(24);

    expect(result.deleted).toBe(3);
    const remaining = await prisma.smartMoneySignal.count();
    expect(remaining).toBe(2);
  });
});
