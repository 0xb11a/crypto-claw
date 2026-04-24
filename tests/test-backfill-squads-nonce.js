/**
 * Test backfill-squads-nonce.js — proves the matcher correctly maps stuck
 * receipts to their Squads transactionIndex and that applyBackfill updates
 * the receipts table safely.
 */

import { test, testAsync, assertEqual, summary } from './test-helpers.js';
import { resolve } from 'path';
import { unlinkSync, existsSync } from 'fs';
import { matchReceiptsToIndices, applyBackfill } from '../scripts/backfill-squads-nonce.js';

const TEST_DB = resolve(process.cwd(), 'data', `test-backfill-squads-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;
process.env.SAFE_ID = 'test-backfill-squads';

const { getDb, close } = await import('../scripts/db.js');

function resetDb() {
  close();
  for (const ext of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${ext}`;
    if (existsSync(f)) unlinkSync(f);
  }
  return getDb();
}

function insertReceipt(db, row) {
  db.prepare(
    `INSERT INTO receipts (id, order_id, action, symbol, address, chain, status, onchain_tx_hash, safe_nonce)
     VALUES (?, ?, 'buy', ?, 'addr', 'solana', 'queued_in_squads', ?, ?)`,
  ).run(row.id, `ord-${row.id}`, row.symbol, row.onchain_tx_hash, row.safe_nonce ?? null);
}

const makeFetcher = (onChainMap) => async (idx) => onChainMap[idx] || [];

console.log('\n📦 backfill-squads-nonce — matcher (pure function)');

await testAsync('matches single stuck receipt to correct txIndex', async () => {
  const receipts = [{ id: 'rcpt-A', symbol: 'FOO', onchain_tx_hash: 'sigA' }];
  const onChain = {
    150: ['sig-unrelated-150a', 'sig-unrelated-150b'],
    149: ['sigA'],
    148: ['sig-old-148'],
  };
  const { matches, unmatched } = await matchReceiptsToIndices({
    receipts,
    maxIndex: 150,
    minIndex: 1,
    fetchSigs: makeFetcher(onChain),
  });
  assertEqual(matches.length, 1);
  assertEqual(matches[0].receiptId, 'rcpt-A');
  assertEqual(matches[0].txIndex, 149);
  assertEqual(matches[0].metaSig, 'sigA');
  assertEqual(unmatched.length, 0);
});

await testAsync('matches multiple receipts in a single scan', async () => {
  const receipts = [
    { id: 'rcpt-FOF', symbol: 'FOF', onchain_tx_hash: 'sigFOF' },
    { id: 'rcpt-FAP', symbol: 'Fapcoin', onchain_tx_hash: 'sigFAP' },
  ];
  const onChain = {
    220: ['sigFAP', 'extra-exec-sig'],
    219: ['noise'],
    218: ['sigFOF'],
    217: [],
    216: ['other'],
  };
  const { matches, unmatched } = await matchReceiptsToIndices({
    receipts,
    maxIndex: 220,
    minIndex: 1,
    fetchSigs: makeFetcher(onChain),
  });
  assertEqual(matches.length, 2);
  assertEqual(unmatched.length, 0);
  const byId = Object.fromEntries(matches.map((m) => [m.receiptId, m.txIndex]));
  assertEqual(byId['rcpt-FAP'], 220);
  assertEqual(byId['rcpt-FOF'], 218);
});

await testAsync('short-circuits when all receipts matched', async () => {
  const receipts = [{ id: 'rcpt-X', symbol: 'X', onchain_tx_hash: 'sigX' }];
  const visited = [];
  await matchReceiptsToIndices({
    receipts,
    maxIndex: 100,
    minIndex: 1,
    fetchSigs: async (idx) => {
      visited.push(idx);
      return idx === 100 ? ['sigX'] : [];
    },
  });
  assertEqual(visited.length, 1, `visited ${visited.join(',')}`);
  assertEqual(visited[0], 100);
});

await testAsync('reports unmatched when scan depth too shallow', async () => {
  const receipts = [{ id: 'rcpt-DEEP', symbol: 'DEEP', onchain_tx_hash: 'sigDeep' }];
  const { matches, unmatched } = await matchReceiptsToIndices({
    receipts,
    maxIndex: 200,
    minIndex: 150,
    fetchSigs: makeFetcher({ 100: ['sigDeep'] }),
  });
  assertEqual(matches.length, 0);
  assertEqual(unmatched.length, 1);
  assertEqual(unmatched[0].receiptId, 'rcpt-DEEP');
});

await testAsync('RPC error on one index does not break scan', async () => {
  const receipts = [{ id: 'rcpt-OK', symbol: 'OK', onchain_tx_hash: 'sigOK' }];
  const errors = [];
  const { matches } = await matchReceiptsToIndices({
    receipts,
    maxIndex: 50,
    minIndex: 1,
    fetchSigs: async (idx) => {
      if (idx === 50) throw new Error('429 Too Many Requests');
      if (idx === 49) return ['sigOK'];
      return [];
    },
    onError: (idx, err) => errors.push({ idx, msg: err.message }),
  });
  assertEqual(errors.length, 1);
  assertEqual(errors[0].idx, 50);
  assertEqual(matches.length, 1);
  assertEqual(matches[0].txIndex, 49);
});

console.log('\n📦 backfill-squads-nonce — applyBackfill (real receipts schema)');

test('only updates rows with NULL safe_nonce', () => {
  const db = resetDb();
  insertReceipt(db, { id: 'rcpt-A', symbol: 'FOO', onchain_tx_hash: 'sigA', safe_nonce: null });
  insertReceipt(db, { id: 'rcpt-B', symbol: 'BAR', onchain_tx_hash: 'sigB', safe_nonce: 77 });

  const updated = applyBackfill(db, [
    { receiptId: 'rcpt-A', txIndex: 149, metaSig: 'sigA', symbol: 'FOO' },
    { receiptId: 'rcpt-B', txIndex: 999, metaSig: 'sigB', symbol: 'BAR' },
  ]);
  assertEqual(updated, 1, 'only NULL row updated');

  const a = db.prepare("SELECT safe_nonce FROM receipts WHERE id = 'rcpt-A'").get();
  const b = db.prepare("SELECT safe_nonce FROM receipts WHERE id = 'rcpt-B'").get();
  assertEqual(a.safe_nonce, 149, 'rcpt-A got correct nonce');
  assertEqual(b.safe_nonce, 77, 'rcpt-B preserved');
});

test('nonexistent receipt IDs are silently ignored', () => {
  const db = resetDb();
  insertReceipt(db, { id: 'rcpt-REAL', symbol: 'X', onchain_tx_hash: 'sigR', safe_nonce: null });
  const updated = applyBackfill(db, [
    { receiptId: 'rcpt-GHOST', txIndex: 1, metaSig: 'sigG', symbol: 'G' },
    { receiptId: 'rcpt-REAL', txIndex: 42, metaSig: 'sigR', symbol: 'X' },
  ]);
  assertEqual(updated, 1);
  const r = db.prepare("SELECT safe_nonce FROM receipts WHERE id = 'rcpt-REAL'").get();
  assertEqual(r.safe_nonce, 42);
});

console.log('\n📦 backfill-squads-nonce — end-to-end simulation');

await testAsync('loads stuck receipts, matches, updates — idempotent', async () => {
  const db = resetDb();
  insertReceipt(db, { id: 'rcpt-1777007483231-id0kj2', symbol: 'Fapcoin', onchain_tx_hash: 'sigFAP' });
  insertReceipt(db, { id: 'rcpt-1776954033380-f6ccnk', symbol: 'FOF', onchain_tx_hash: 'sigFOF' });
  // a row that shouldn't be touched — already has a nonce
  db.prepare(
    `INSERT INTO receipts (id, order_id, action, symbol, address, chain, status, onchain_tx_hash, safe_nonce)
     VALUES ('rcpt-already-ok', 'ord-3', 'buy', 'OK', 'addr', 'solana', 'queued_in_squads', 'sigOK', 42)`,
  ).run();
  // a row on a different chain — shouldn't be returned by the stuck-receipts query
  db.prepare(
    `INSERT INTO receipts (id, order_id, action, symbol, address, chain, status, onchain_tx_hash, safe_nonce)
     VALUES ('rcpt-evm', 'ord-4', 'buy', 'EVM', 'addr', 'base', 'queued_in_safe', '0xabc', NULL)`,
  ).run();

  // Simulate what loadStuckReceipts does in production
  const stuck = db
    .prepare(
      `SELECT id, symbol, chain, onchain_tx_hash, safe_nonce, created_at FROM receipts
       WHERE status='queued_in_squads' AND chain='solana'
         AND safe_nonce IS NULL AND onchain_tx_hash IS NOT NULL`,
    )
    .all();
  assertEqual(stuck.length, 2, 'filters correctly (skips EVM and already-ok rows)');

  const onChain = {
    312: ['some-exec-sig-from-a-different-tx'],
    311: ['sigFAP'],
    310: [],
    309: ['unrelated-sig-from-another-wallet'],
    308: [],
    307: [],
    306: [],
    305: ['sigFOF', 'older-sig-on-same-pda'],
  };
  const { matches, unmatched } = await matchReceiptsToIndices({
    receipts: stuck,
    maxIndex: 312,
    minIndex: 1,
    fetchSigs: makeFetcher(onChain),
  });
  assertEqual(matches.length, 2);
  assertEqual(unmatched.length, 0);

  const updated = applyBackfill(db, matches);
  assertEqual(updated, 2);

  const rows = db.prepare("SELECT id, safe_nonce FROM receipts WHERE chain='solana' ORDER BY id").all();
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.safe_nonce]));
  assertEqual(byId['rcpt-1777007483231-id0kj2'], 311, 'Fapcoin nonce');
  assertEqual(byId['rcpt-1776954033380-f6ccnk'], 305, 'FOF nonce');
  assertEqual(byId['rcpt-already-ok'], 42, 'existing nonce untouched');

  // Idempotency: re-running must not overwrite
  const updated2 = applyBackfill(db, matches);
  assertEqual(updated2, 0, 'second apply is no-op');
});

// Cleanup
close();
for (const ext of ['', '-shm', '-wal']) {
  const f = `${TEST_DB}${ext}`;
  if (existsSync(f)) unlinkSync(f);
}

summary();
