#!/usr/bin/env node
/**
 * score-wallets-bg.js — Background wallet scoring pipeline
 *
 * Picks up unscored wallets from the database, scores them via score-wallet.js,
 * and writes results back. Runs one cycle then exits (called repeatedly from a
 * shell loop in entrypoint.sh or system cron).
 *
 * Per cycle:
 *   0. Harvest Birdeye leaderboards if ≥60 min since last harvest
 *   1. Query get-unscored-wallets --limit 10
 *   2. For each: set status=scoring, run score-wallet.js, update result
 *   3. Wait 3s between wallets (rate limit respect)
 *   4. Output summary JSON
 *
 * Usage:
 *   node scripts/score-wallets-bg.js
 *
 * Environment:
 *   SAFE_ID / DB_PATH — standard database config
 *   BIRDEYE_API_KEY / ZERION_API_KEY — scoring APIs
 */

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb, close } from './db.js';
import { harvestBirdeyeLeaderboards } from './harvest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCORE_WALLET_SCRIPT = resolve(__dirname, 'score-wallet.js');
const BATCH_SIZE = 10;
const DELAY_MS = 3000;
const HARVEST_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', error: `DB init failed: ${err.message}` }));
    process.exit(1);
  }

  // 0. Self-seed: fetch Birdeye leaderboards (every 60 min, skip if too soon)
  let totalHarvested = 0;
  try {
    const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'last_harvest_at'").get();
    const lastHarvest = row ? new Date(row.value).getTime() : 0;
    const elapsed = Date.now() - lastHarvest;

    if (elapsed >= HARVEST_INTERVAL_MS) {
      const harvest = await harvestBirdeyeLeaderboards();
      totalHarvested = harvest.totalHarvested;
      db.prepare("INSERT OR REPLACE INTO portfolio_meta (key, value) VALUES ('last_harvest_at', ?)").run(
        new Date().toISOString(),
      );
      if (totalHarvested > 0) {
        console.error(`[wallet-scorer] Harvested ${totalHarvested} wallets: ${JSON.stringify(harvest.chains)}`);
      }
    } else {
      const minLeft = Math.round((HARVEST_INTERVAL_MS - elapsed) / 60000);
      console.error(`[wallet-scorer] Harvest skipped (next in ${minLeft}m)`);
    }
  } catch (err) {
    console.error(`[wallet-scorer] Harvest failed (non-fatal): ${err.message}`);
  }

  try {
    // 1. Get unscored wallets
    const wallets = db
      .prepare(
        `
      SELECT * FROM tracked_wallets
      WHERE status = 'proposed' OR (status = 'failed' AND retry_count < 3)
      ORDER BY created_at ASC
      LIMIT ?
    `,
      )
      .all(BATCH_SIZE);

    if (wallets.length === 0) {
      console.log(
        JSON.stringify({
          status: 'ok',
          scored: 0,
          failed: 0,
          skipped: 0,
          harvested: totalHarvested,
          message: 'No wallets to score',
        }),
      );
      return;
    }

    let scored = 0;
    let failed = 0;
    const skipped = 0;

    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];

      // 2. Set status to scoring
      db.prepare("UPDATE tracked_wallets SET status = 'scoring' WHERE address = ? AND chain = ?").run(
        wallet.address,
        wallet.chain,
      );

      try {
        // 3. Run score-wallet.js
        const args = ['--address', wallet.address, '--chain', wallet.chain];
        if (wallet.source_token) {
          args.push('--token', wallet.source_token);
        }

        const output = execFileSync('node', [SCORE_WALLET_SCRIPT, ...args], {
          timeout: 30000,
          encoding: 'utf-8',
          env: process.env,
        });

        const result = JSON.parse(output.trim());

        if (result.status === 'ok' && result.score) {
          // Success — update with score
          db.prepare(
            `
            UPDATE tracked_wallets
            SET status = 'scored', score = ?, type = ?, score_breakdown = ?,
                scored_at = datetime('now'), score_error = NULL
            WHERE address = ? AND chain = ?
          `,
          ).run(
            result.score.overall,
            result.score.classification,
            JSON.stringify(result.score.breakdown),
            wallet.address,
            wallet.chain,
          );
          scored++;
          console.error(
            `[wallet-scorer] Scored ${wallet.address} (${wallet.chain}): ${result.score.overall} → ${result.score.classification}`,
          );
        } else if (result.status === 'no_data') {
          // No data available — mark failed
          db.prepare(
            `
            UPDATE tracked_wallets
            SET status = 'failed', retry_count = retry_count + 1,
                score_error = ?, scored_at = datetime('now')
            WHERE address = ? AND chain = ?
          `,
          ).run(result.message || 'No data from scoring APIs', wallet.address, wallet.chain);
          failed++;
          console.error(`[wallet-scorer] No data for ${wallet.address} (${wallet.chain}): ${result.message}`);
        } else {
          // Unexpected response
          db.prepare(
            `
            UPDATE tracked_wallets
            SET status = 'failed', retry_count = retry_count + 1,
                score_error = ?, scored_at = datetime('now')
            WHERE address = ? AND chain = ?
          `,
          ).run(`Unexpected response: ${result.status}`, wallet.address, wallet.chain);
          failed++;
        }
      } catch (err) {
        // Script error — mark failed
        const errorMsg = err.stderr ? err.stderr.toString().slice(0, 200) : err.message;
        db.prepare(
          `
          UPDATE tracked_wallets
          SET status = 'failed', retry_count = retry_count + 1,
              score_error = ?, scored_at = datetime('now')
          WHERE address = ? AND chain = ?
        `,
        ).run(errorMsg, wallet.address, wallet.chain);
        failed++;
        console.error(`[wallet-scorer] Error scoring ${wallet.address} (${wallet.chain}): ${errorMsg}`);
      }

      // 4. Rate limit delay (skip after last wallet)
      if (i < wallets.length - 1) {
        await sleep(DELAY_MS);
      }
    }

    console.log(JSON.stringify({ status: 'ok', scored, failed, skipped, harvested: totalHarvested }));
  } finally {
    close();
  }
}

main();
