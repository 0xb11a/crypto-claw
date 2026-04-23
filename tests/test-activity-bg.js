#!/usr/bin/env node
/**
 * Test Suite: activity-wallets-bg producer + smart_money_signals consumer
 *
 * Covers:
 *   1. Schema — table exists with expected columns + UNIQUE constraint
 *   2. Swap extraction (EVM): single buy, single sell, two-sided dedup, airdrop
 *      filtering (one-sided transfer skipped)
 *   3. Swap extraction (Solana): SWAP type, non-SWAP filtered out
 *   4. UNIQUE dedup across cycles (same tx replayed → 1 row)
 *   5. Rotation: ORDER BY last_checked_at ASC NULLS FIRST picks oldest first
 *   6. Pruning: signals older than 24 h are deleted by the producer's retention rule
 */

import { describe, test, assert, assertEqual, summary } from './test-helpers.js';

let db;
let dbAvailable = false;
let extractEvmSwaps;
let extractSolanaSwaps;

try {
  const dbModule = await import('../scripts/db.js');
  db = dbModule.getDb();
  dbAvailable = true;
  const bgModule = await import('../scripts/activity-wallets-bg.js');
  extractEvmSwaps = bgModule.extractEvmSwaps;
  extractSolanaSwaps = bgModule.extractSolanaSwaps;
} catch (e) {
  console.log(`\n⚠️  Skipping activity-bg tests (${e.message})`);
  console.log('   Run "npm install" in scripts/ to enable\n');
}

if (dbAvailable) {
  // Test isolation — clean any prior test rows before/after
  const TEST_WALLET = '0xtestwallet0000000000000000000000000000aa';
  const TEST_CHAIN = 'base';
  const cleanup = () => {
    db.prepare(
      "DELETE FROM smart_money_signals WHERE wallet_address LIKE '0xtestwallet%' OR tx_hash LIKE '0xtesttx%'",
    ).run();
    db.prepare("DELETE FROM tracked_wallets WHERE address LIKE '0xtestwallet%'").run();
  };

  describe('smart_money_signals — Schema', () => {
    cleanup();

    test('table exists', () => {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='smart_money_signals'").get();
      assert(row, 'smart_money_signals table must exist');
    });

    test('has expected columns', () => {
      const cols = db
        .prepare('PRAGMA table_info(smart_money_signals)')
        .all()
        .map((c) => c.name);
      for (const col of [
        'id',
        'tx_hash',
        'chain',
        'wallet_address',
        'wallet_score',
        'wallet_label',
        'action',
        'token_address',
        'token_symbol',
        'counter_token_address',
        'counter_token_symbol',
        'amount_token',
        'tx_timestamp',
        'created_at',
      ]) {
        assert(cols.includes(col), `must have column '${col}'`);
      }
    });

    test('action is constrained to buy|sell', () => {
      let threw = false;
      try {
        db.prepare(
          `INSERT INTO smart_money_signals
           (tx_hash, chain, wallet_address, action, token_address, tx_timestamp)
           VALUES ('0xtesttx_check_action', 'base', '0xtestwallet1', 'invalid', '0xtok', '2026-01-01')`,
        ).run();
      } catch {
        threw = true;
      }
      assert(threw, "CHECK constraint must reject action other than 'buy' or 'sell'");
    });

    test('UNIQUE on (tx_hash, wallet_address, action, token_address)', () => {
      db.prepare(
        `INSERT OR IGNORE INTO smart_money_signals
         (tx_hash, chain, wallet_address, action, token_address, tx_timestamp)
         VALUES ('0xtesttx_unique', 'base', '0xtestwallet2', 'buy', '0xtok', '2026-01-01')`,
      ).run();
      const second = db
        .prepare(
          `INSERT OR IGNORE INTO smart_money_signals
           (tx_hash, chain, wallet_address, action, token_address, tx_timestamp)
           VALUES ('0xtesttx_unique', 'base', '0xtestwallet2', 'buy', '0xtok', '2026-01-01')`,
        )
        .run();
      assertEqual(second.changes, 0, 'duplicate insert must be ignored by UNIQUE constraint');
    });

    test('tracked_wallets has last_checked_at column for rotation', () => {
      const cols = db
        .prepare('PRAGMA table_info(tracked_wallets)')
        .all()
        .map((c) => c.name);
      assert(cols.includes('last_checked_at'), 'tracked_wallets must have last_checked_at column');
    });

    cleanup();
  });

  describe('extractEvmSwaps — Swap Detection', () => {
    // Base USDC + WETH (lowercase to match the function's normalization)
    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const WETH = '0x4200000000000000000000000000000000000006';
    const TOKEN = '0x1234567890123456789012345678901234567890';

    const mkTransfer = (hash, from, to, contract, symbol, value, ts = '1700000000') => ({
      hash,
      from,
      to,
      contractAddress: contract,
      tokenSymbol: symbol,
      value,
      timeStamp: ts,
    });

    test('detects USDC → TOKEN as buy', () => {
      const transfers = [
        mkTransfer('0xtesttx_buy1', TEST_WALLET, '0xrouter', USDC, 'USDC', '1000000000'),
        mkTransfer('0xtesttx_buy1', '0xrouter', TEST_WALLET, TOKEN, 'TOKEN', '5000000000000000000'),
      ];
      const swaps = extractEvmSwaps(transfers, TEST_WALLET, TEST_CHAIN);
      assertEqual(swaps.length, 1, 'must emit exactly one signal');
      assertEqual(swaps[0].action, 'buy', 'action must be buy');
      assertEqual(swaps[0].token_address, TOKEN, 'subject token must be TOKEN');
      assertEqual(swaps[0].counter_token_address, USDC, 'counter must be USDC');
    });

    test('detects TOKEN → USDC as sell', () => {
      const transfers = [
        mkTransfer('0xtesttx_sell1', TEST_WALLET, '0xrouter', TOKEN, 'TOKEN', '5000000000000000000'),
        mkTransfer('0xtesttx_sell1', '0xrouter', TEST_WALLET, USDC, 'USDC', '1500000000'),
      ];
      const swaps = extractEvmSwaps(transfers, TEST_WALLET, TEST_CHAIN);
      assertEqual(swaps.length, 1, 'must emit exactly one signal');
      assertEqual(swaps[0].action, 'sell', 'action must be sell');
      assertEqual(swaps[0].token_address, TOKEN, 'subject token must be TOKEN');
    });

    test('detects WETH → TOKEN as buy (wnative as counter)', () => {
      const transfers = [
        mkTransfer('0xtesttx_wbuy', TEST_WALLET, '0xrouter', WETH, 'WETH', '1000000000000000000'),
        mkTransfer('0xtesttx_wbuy', '0xrouter', TEST_WALLET, TOKEN, 'TOKEN', '5000000000000000000'),
      ];
      const swaps = extractEvmSwaps(transfers, TEST_WALLET, TEST_CHAIN);
      assertEqual(swaps.length, 1, 'WETH-side swap must be detected as a buy');
      assertEqual(swaps[0].action, 'buy');
    });

    test('skips one-sided transfer (airdrop / dust)', () => {
      const transfers = [mkTransfer('0xtesttx_air', '0xairdropper', TEST_WALLET, TOKEN, 'TOKEN', '1')];
      const swaps = extractEvmSwaps(transfers, TEST_WALLET, TEST_CHAIN);
      assertEqual(swaps.length, 0, 'IN-only transfer with no OUT must NOT emit a signal');
    });

    test('skips token↔token swap with no stable/native side', () => {
      const TOKEN2 = '0xabcdef0000000000000000000000000000abcdef';
      const transfers = [
        mkTransfer('0xtesttx_tt', TEST_WALLET, '0xrouter', TOKEN, 'TOKEN', '1'),
        mkTransfer('0xtesttx_tt', '0xrouter', TEST_WALLET, TOKEN2, 'TOKEN2', '1'),
      ];
      const swaps = extractEvmSwaps(transfers, TEST_WALLET, TEST_CHAIN);
      assertEqual(swaps.length, 0, 'token-only swap without stable/native side must be skipped');
    });

    test('two distinct swaps in different txs both emit signals', () => {
      const transfers = [
        mkTransfer('0xtesttx_two1', TEST_WALLET, '0xr', USDC, 'USDC', '1'),
        mkTransfer('0xtesttx_two1', '0xr', TEST_WALLET, TOKEN, 'TOKEN', '1'),
        mkTransfer('0xtesttx_two2', TEST_WALLET, '0xr', TOKEN, 'TOKEN', '1'),
        mkTransfer('0xtesttx_two2', '0xr', TEST_WALLET, USDC, 'USDC', '1'),
      ];
      const swaps = extractEvmSwaps(transfers, TEST_WALLET, TEST_CHAIN);
      assertEqual(swaps.length, 2, 'two swaps across two tx hashes → two signals');
      const actions = swaps.map((s) => s.action).sort();
      assertEqual(actions[0], 'buy');
      assertEqual(actions[1], 'sell');
    });
  });

  describe('extractSolanaSwaps — Helius Parsed-Tx Format', () => {
    const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const WSOL = 'So11111111111111111111111111111111111111112';
    const SOL_TOKEN = 'TokenMint11111111111111111111111111111111111';
    const SOL_WALLET = 'WalletAddress11111111111111111111111111111';

    test('SWAP type with USDC out + token in → buy', () => {
      const txs = [
        {
          signature: 'sig_buy_1',
          type: 'SWAP',
          timestamp: 1700000000,
          tokenTransfers: [
            {
              fromUserAccount: SOL_WALLET,
              toUserAccount: 'pool',
              mint: SOL_USDC,
              tokenAmount: 100,
              tokenSymbol: 'USDC',
            },
            {
              fromUserAccount: 'pool',
              toUserAccount: SOL_WALLET,
              mint: SOL_TOKEN,
              tokenAmount: 5000,
              tokenSymbol: 'TKN',
            },
          ],
        },
      ];
      const swaps = extractSolanaSwaps(txs, SOL_WALLET, 'solana');
      assertEqual(swaps.length, 1, 'must emit one signal');
      assertEqual(swaps[0].action, 'buy', 'USDC out + token in = buy');
      assertEqual(swaps[0].token_address, SOL_TOKEN);
      assertEqual(swaps[0].counter_token_address, SOL_USDC);
    });

    test('non-SWAP types are ignored', () => {
      const txs = [
        { signature: 'sig_x', type: 'TRANSFER', timestamp: 1700000000, tokenTransfers: [] },
        { signature: 'sig_y', type: 'NFT_BID', timestamp: 1700000000, tokenTransfers: [] },
      ];
      const swaps = extractSolanaSwaps(txs, SOL_WALLET, 'solana');
      assertEqual(swaps.length, 0, 'non-SWAP types must be filtered');
    });

    test('WSOL out + token in is detected (wnative as counter)', () => {
      const txs = [
        {
          signature: 'sig_wsol',
          type: 'SWAP',
          timestamp: 1700000000,
          tokenTransfers: [
            { fromUserAccount: SOL_WALLET, toUserAccount: 'pool', mint: WSOL, tokenAmount: 1, tokenSymbol: 'WSOL' },
            {
              fromUserAccount: 'pool',
              toUserAccount: SOL_WALLET,
              mint: SOL_TOKEN,
              tokenAmount: 100,
              tokenSymbol: 'TKN',
            },
          ],
        },
      ];
      const swaps = extractSolanaSwaps(txs, SOL_WALLET, 'solana');
      assertEqual(swaps.length, 1, 'WSOL-side swap must be detected as a buy');
      assertEqual(swaps[0].action, 'buy');
    });
  });

  describe('Rotation — ORDER BY last_checked_at ASC NULLS FIRST', () => {
    cleanup();

    test('NULL last_checked_at wallets come before timestamped ones', () => {
      // 3 wallets: one never checked, one checked yesterday, one checked an hour ago
      const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString();
      const oneHrAgo = new Date(Date.now() - 3600_000).toISOString();
      db.prepare(
        `INSERT OR REPLACE INTO tracked_wallets
         (address, chain, type, status, score, last_checked_at)
         VALUES (?, 'base', 'smart_money', 'scored', 80, NULL)`,
      ).run('0xtestwallet_rot_null');
      db.prepare(
        `INSERT OR REPLACE INTO tracked_wallets
         (address, chain, type, status, score, last_checked_at)
         VALUES (?, 'base', 'smart_money', 'scored', 80, ?)`,
      ).run('0xtestwallet_rot_yest', yesterday);
      db.prepare(
        `INSERT OR REPLACE INTO tracked_wallets
         (address, chain, type, status, score, last_checked_at)
         VALUES (?, 'base', 'smart_money', 'scored', 80, ?)`,
      ).run('0xtestwallet_rot_hour', oneHrAgo);

      const picked = db
        .prepare(
          `SELECT address FROM tracked_wallets
           WHERE address LIKE '0xtestwallet_rot_%'
           ORDER BY (last_checked_at IS NULL) DESC, last_checked_at ASC
           LIMIT 3`,
        )
        .all()
        .map((r) => r.address);

      assertEqual(picked[0], '0xtestwallet_rot_null', 'NULL last_checked_at wallet must be picked first');
      assertEqual(picked[1], '0xtestwallet_rot_yest', 'next must be the yesterday-checked wallet');
      assertEqual(picked[2], '0xtestwallet_rot_hour', 'most recently checked wallet comes last');
    });

    cleanup();
  });

  describe('Retention — 24 h prune rule', () => {
    cleanup();

    test('signals older than 24 h are removed by the prune query', () => {
      // Insert one fresh and one old signal
      db.prepare(
        `INSERT INTO smart_money_signals
         (tx_hash, chain, wallet_address, action, token_address, tx_timestamp, created_at)
         VALUES ('0xtesttx_fresh', 'base', '0xtestwallet_p1', 'buy', '0xtok', '2026-01-01', datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO smart_money_signals
         (tx_hash, chain, wallet_address, action, token_address, tx_timestamp, created_at)
         VALUES ('0xtesttx_old', 'base', '0xtestwallet_p2', 'buy', '0xtok', '2026-01-01', datetime('now', '-25 hours'))`,
      ).run();

      const before = db.prepare("SELECT COUNT(*) c FROM smart_money_signals WHERE tx_hash LIKE '0xtesttx_%'").get().c;
      assertEqual(before, 2, 'should have 2 test signals before prune');

      // Apply the same prune the producer does
      db.prepare("DELETE FROM smart_money_signals WHERE created_at < datetime('now', ?)").run('-24 hours');

      const fresh = db.prepare("SELECT 1 FROM smart_money_signals WHERE tx_hash = '0xtesttx_fresh'").get();
      const old = db.prepare("SELECT 1 FROM smart_money_signals WHERE tx_hash = '0xtesttx_old'").get();
      assert(fresh, 'fresh signal must survive prune');
      assert(!old, '25-hour-old signal must be deleted');
    });

    cleanup();
  });
}

const ok = summary();
process.exit(ok ? 0 : 1);
