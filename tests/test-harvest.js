#!/usr/bin/env node
/**
 * Test Suite: Wallet Harvesting
 *
 * Tests the shared harvestWallets() function from harvest.js:
 * 1. Inserts wallets with status='proposed' and correct source/label
 * 2. Duplicates are ignored (INSERT OR IGNORE)
 * 3. excludeAddress is skipped
 * 4. Empty/null addresses are skipped
 * 5. Returns correct harvested count
 */

import { describe, test, assert, assertEqual, summary } from './test-helpers.js';

let db;
let dbAvailable = false;
let harvestWallets;

try {
  const dbModule = await import('../scripts/db.js');
  db = dbModule.getDb();
  dbAvailable = true;
  const harvestModule = await import('../scripts/harvest.js');
  harvestWallets = harvestModule.harvestWallets;
} catch (e) {
  console.log(`\n⚠️  Skipping harvest tests (${e.message})`);
  console.log('   Run "npm install" in scripts/ to enable harvest tests\n');
}

if (dbAvailable) {
  // Use a real EVM chain: PR 1.3 added address validation that rejects
  // unknown chains. Test addresses are all-digits hex so they round-trip
  // through viem.getAddress() unchanged (no checksum case-flipping).
  const TEST_CHAIN = 'ethereum';
  const ADDR_A = '0x' + '1'.repeat(40);
  const ADDR_B = '0x' + '2'.repeat(40);
  const ADDR_C = '0x' + '3'.repeat(40);
  // Marker so cleanup can find these specific test rows without affecting
  // other rows on the shared `ethereum` chain.
  const TEST_LABEL_PREFIX = '__test_harvest__';
  const cleanup = () => {
    db.prepare('DELETE FROM tracked_wallets WHERE label LIKE ?').run(`${TEST_LABEL_PREFIX}%`);
  };

  describe('harvestWallets — Core', () => {
    cleanup();

    test('inserts wallets with status=proposed and correct source/label', () => {
      const count = harvestWallets(
        [ADDR_A, ADDR_B, ADDR_C],
        TEST_CHAIN,
        (addr) => `${TEST_LABEL_PREFIX}_${addr}`,
        'test_source',
        null,
      );
      assertEqual(count, 3, 'Should insert 3 wallets');

      const rows = db
        .prepare('SELECT * FROM tracked_wallets WHERE label LIKE ? ORDER BY address')
        .all(`${TEST_LABEL_PREFIX}%`);
      assertEqual(rows.length, 3, 'DB should have 3 rows');
      assertEqual(rows[0].status, 'proposed', 'Status should be proposed');
      assertEqual(rows[0].source, 'test_source', 'Source should match');
      assertEqual(rows[0].label, `${TEST_LABEL_PREFIX}_${ADDR_A}`, 'Label should match labelFn output');
    });

    test('duplicates are ignored (returns 0 for existing)', () => {
      const count = harvestWallets(
        [ADDR_A, ADDR_B],
        TEST_CHAIN,
        (addr) => `${TEST_LABEL_PREFIX}_dup_${addr}`,
        'test_source',
        null,
      );
      assertEqual(count, 0, 'Should insert 0 (all duplicates)');

      const rows = db.prepare('SELECT * FROM tracked_wallets WHERE label LIKE ?').all(`${TEST_LABEL_PREFIX}%`);
      assertEqual(rows.length, 3, 'DB should still have 3 rows');
      // Labels should NOT be updated (INSERT OR IGNORE keeps original)
      const first = db
        .prepare('SELECT label FROM tracked_wallets WHERE address = ? AND chain = ?')
        .get(ADDR_A, TEST_CHAIN);
      assertEqual(first.label, `${TEST_LABEL_PREFIX}_${ADDR_A}`, 'Original label should be preserved');
    });

    test('excludeAddress is skipped', () => {
      cleanup();
      const count = harvestWallets(
        [ADDR_A, ADDR_B, ADDR_C],
        TEST_CHAIN,
        () => `${TEST_LABEL_PREFIX}_excl`,
        'test_source',
        ADDR_B,
      );
      assertEqual(count, 2, 'Should insert 2 (excluded ADDR_B)');

      const rows = db
        .prepare('SELECT address FROM tracked_wallets WHERE label LIKE ? ORDER BY address')
        .all(`${TEST_LABEL_PREFIX}%`);
      assertEqual(rows.length, 2, 'DB should have 2 rows');
      assert(!rows.some((r) => r.address === ADDR_B), 'ADDR_B should not be in DB');
    });

    test('excludeAddress is case-insensitive', () => {
      cleanup();
      // Lowercase input, uppercase exclude — should still match.
      const count = harvestWallets(
        [ADDR_A, ADDR_B.toLowerCase()],
        TEST_CHAIN,
        () => `${TEST_LABEL_PREFIX}_case`,
        'test_source',
        ADDR_B,
      );
      assertEqual(count, 1, 'Should insert 1 (case-insensitive exclude)');
    });

    test('empty and null addresses are skipped', () => {
      cleanup();
      const count = harvestWallets(
        [ADDR_A, '', null, undefined, ADDR_B],
        TEST_CHAIN,
        () => `${TEST_LABEL_PREFIX}_empty`,
        'test_source',
        null,
      );
      assertEqual(count, 2, 'Should insert 2 (skipped empty/null/undefined)');
    });

    test('empty array returns 0', () => {
      cleanup();
      const count = harvestWallets([], TEST_CHAIN, () => `${TEST_LABEL_PREFIX}_x`, 'test_source', null);
      assertEqual(count, 0, 'Should return 0 for empty array');
    });

    test('invalid addresses are dropped (PR 1.3 — checksum validation)', () => {
      cleanup();
      const count = harvestWallets(
        [ADDR_A, '0xdead', '0x' + 'g'.repeat(40), ADDR_B],
        TEST_CHAIN,
        () => `${TEST_LABEL_PREFIX}_invalid`,
        'test_source',
        null,
      );
      assertEqual(count, 2, 'Should insert 2 (dropped 2 invalid CAs)');
    });

    // Final cleanup
    cleanup();
  });
}

const passed = summary();
process.exit(passed ? 0 : 1);
