/**
 * Prisma seed — idempotent setup data for P1 entities.
 *
 * Seeds heartbeat_state rows and portfolio_meta defaults that match the
 * legacy scripts/db.js migration 001 inserts. Uses upsert for idempotency
 * so running seed multiple times on the same DB produces the same result.
 *
 * Run: pnpm prisma db seed
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // -------------------------------------------------------------------------
  // portfolio_meta — migration 001 defaults
  // -------------------------------------------------------------------------

  const metaSeeds = [
    { key: 'cash', value: '0' },
    { key: 'total_deposited', value: '0' },
    { key: 'cash_base', value: '0' },
    { key: 'cash_solana', value: '0' },
    { key: 'cash_ethereum', value: '0' },
    { key: 'paper_cash', value: '10000' },
    { key: 'paper_initial_balance', value: '10000' },
    { key: 'paper_cash_base', value: '10000' },
    { key: 'paper_cash_solana', value: '0' },
    { key: 'paper_cash_ethereum', value: '0' },
    { key: 'paper_initial_balance_base', value: '10000' },
    { key: 'paper_initial_balance_solana', value: '0' },
    { key: 'paper_initial_balance_ethereum', value: '0' },
    { key: 'total_deposited_base', value: '0' },
    { key: 'total_deposited_solana', value: '0' },
    { key: 'total_deposited_ethereum', value: '0' },
    { key: 'market_regime', value: 'neutral' },
    { key: 'market_regime_history', value: '[]' },
  ];

  for (const meta of metaSeeds) {
    await prisma.portfolioMeta.upsert({
      where: { key: meta.key },
      update: {},
      create: { key: meta.key, value: meta.value },
    });
  }

  // -------------------------------------------------------------------------
  // heartbeat_state — migration 001 + 004 + 005 + 010 + 013 + 017 + 021 + 023 + 024
  // -------------------------------------------------------------------------

  const heartbeatSeeds = [
    { agent: 'research', checkType: 'sentinel_alerts' },
    { agent: 'research', checkType: 'token_scan' },
    { agent: 'research', checkType: 'smart_money_signals' },
    { agent: 'research', checkType: 'narrative_check' },
    { agent: 'research', checkType: 'rebalance_review' },
    { agent: 'research', checkType: 'daily_summary' },
    { agent: 'research', checkType: 'watchlist_check' },
    { agent: 'research', checkType: 'market_regime' },
    { agent: 'research', checkType: 'conviction_scan' },
    { agent: 'research', checkType: 'base_rebalance' },
    { agent: 'research', checkType: 'portfolio_sync' },
    { agent: 'research', checkType: 'narrative_deep_scan' },
    { agent: 'sentinel', checkType: 'price_check' },
    { agent: 'sentinel', checkType: 'liquidity_check' },
    { agent: 'sentinel', checkType: 'wallet_check' },
    { agent: 'sentinel', checkType: 'contract_check' },
    { agent: 'sentinel', checkType: 'smart_money_exits' },
    { agent: 'executor', checkType: 'process_orders' },
    { agent: 'observer', checkType: 'triage' },
    { agent: 'system', checkType: 'wallet_scoring' },
    { agent: 'system', checkType: 'memory-backup' },
  ];

  for (const hb of heartbeatSeeds) {
    await prisma.heartbeatState.upsert({
      where: { agent_checkType: { agent: hb.agent, checkType: hb.checkType } },
      update: {},
      create: { agent: hb.agent, checkType: hb.checkType },
    });
  }

  console.error('[seed] Prisma seed completed successfully');
}

main()
  .catch((e) => {
    console.error('[seed] Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
