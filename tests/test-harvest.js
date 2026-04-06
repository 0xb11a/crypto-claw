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
  // Clean up any test wallets before/after
  const TEST_CHAIN = '__test_harvest__';
  const cleanup = () => {
    db.prepare('DELETE FROM tracked_wallets WHERE chain = ?').run(TEST_CHAIN);
  };

  describe('harvestWallets — Core', () => {
    cleanup();

    test('inserts wallets with status=proposed and correct source/label', () => {
      const count = harvestWallets(
        ['0xAAA', '0xBBB', '0xCCC'],
        TEST_CHAIN,
        (addr) => `test_label_${addr}`,
        'test_source',
        null,
      );
      assertEqual(count, 3, 'Should insert 3 wallets');

      const rows = db.prepare('SELECT * FROM tracked_wallets WHERE chain = ? ORDER BY address').all(TEST_CHAIN);
      assertEqual(rows.length, 3, 'DB should have 3 rows');
      assertEqual(rows[0].status, 'proposed', 'Status should be proposed');
      assertEqual(rows[0].source, 'test_source', 'Source should match');
      assertEqual(rows[0].label, 'test_label_0xAAA', 'Label should match labelFn output');
    });

    test('duplicates are ignored (returns 0 for existing)', () => {
      const count = harvestWallets(['0xAAA', '0xBBB'], TEST_CHAIN, (addr) => `dup_${addr}`, 'test_source', null);
      assertEqual(count, 0, 'Should insert 0 (all duplicates)');

      const rows = db.prepare('SELECT * FROM tracked_wallets WHERE chain = ?').all(TEST_CHAIN);
      assertEqual(rows.length, 3, 'DB should still have 3 rows');
      // Labels should NOT be updated (INSERT OR IGNORE keeps original)
      const first = db
        .prepare('SELECT label FROM tracked_wallets WHERE address = ? AND chain = ?')
        .get('0xAAA', TEST_CHAIN);
      assertEqual(first.label, 'test_label_0xAAA', 'Original label should be preserved');
    });

    test('excludeAddress is skipped', () => {
      cleanup();
      const count = harvestWallets(
        ['0xAAA', '0xBBB', '0xCCC'],
        TEST_CHAIN,
        () => 'label',
        'test_source',
        '0xBBB', // exclude this one
      );
      assertEqual(count, 2, 'Should insert 2 (excluded 0xBBB)');

      const rows = db.prepare('SELECT address FROM tracked_wallets WHERE chain = ? ORDER BY address').all(TEST_CHAIN);
      assertEqual(rows.length, 2, 'DB should have 2 rows');
      assert(!rows.some((r) => r.address === '0xBBB'), '0xBBB should not be in DB');
    });

    test('excludeAddress is case-insensitive', () => {
      cleanup();
      const count = harvestWallets(
        ['0xAAA', '0xbbb'],
        TEST_CHAIN,
        () => 'label',
        'test_source',
        '0xBBB', // uppercase exclude, lowercase input
      );
      assertEqual(count, 1, 'Should insert 1 (case-insensitive exclude)');
    });

    test('empty and null addresses are skipped', () => {
      cleanup();
      const count = harvestWallets(
        ['0xAAA', '', null, undefined, '0xBBB'],
        TEST_CHAIN,
        () => 'label',
        'test_source',
        null,
      );
      assertEqual(count, 2, 'Should insert 2 (skipped empty/null/undefined)');
    });

    test('empty array returns 0', () => {
      cleanup();
      const count = harvestWallets([], TEST_CHAIN, () => 'label', 'test_source', null);
      assertEqual(count, 0, 'Should return 0 for empty array');
    });

    // Final cleanup
    cleanup();
  });
}

const passed = summary();
process.exit(passed ? 0 : 1);
