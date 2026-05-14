/**
 * score-wallet.service.ts — Pure-function scoring engine for wallet smart-money detection.
 *
 * Port of `scripts/score-wallet.js:computeScore()` — bug-for-bug parity (DoD §I).
 * The formula and thresholds are locked; do not adjust without an explicit SPEC change.
 *
 * Classification thresholds (locked, P3g1 plan):
 *   overall >= 75 → 'smart_money'
 *   overall >= 55 → 'whale'
 *   overall < 55  → 'lowtier'  (legacy used 'trader' for 35–54 and 'retail' below; we
 *                                collapse both to 'lowtier' per P3g1 [OPEN-2] decision)
 *
 * Scoring dimensions (weights unchanged from legacy):
 *   profitability × 0.30
 *   reputation    × 0.25
 *   volume        × 0.20
 *   activity      × 0.15
 *   consistency   × 0.10
 *
 * This class is intentionally NOT decorated with @Injectable() — it is a pure
 * service with no DI dependencies. This simplifies unit testing (no NestJS test
 * harness required) and makes the math boundary explicit.
 *
 * ADR-0026: no ConfigService usage (no env access needed — math only).
 * SPEC §4 #4: no signer-key env vars.
 * SPEC §4 #6: no process.env reads.
 */

import type { TraderRankResult, TokenTopTrader } from '@cclaw/adapters-birdeye';
import type { ZerionPnlResult } from '@cclaw/adapters-zerion';

// ---------------------------------------------------------------------------
// Score dimensions (0–100 each)
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  /** 0–100: PnL performance relative to benchmarks. */
  profitability: number;
  /** 0–100: trade pattern quality (buy/sell ratio). */
  consistency: number;
  /** 0–100: meaningful trading volume in USD. */
  volume: number;
  /** 0–100: active trader signal (trade count). */
  activity: number;
  /** 0–100: appears in leaderboards / top-trader lists. */
  reputation: number;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Wallet classification derived from the overall score.
 *
 * Thresholds are locked per P3g1 plan (originally from `scripts/score-wallet.js:405-417`):
 *   >= 75 → smart_money
 *   >= 55 → whale
 *   <  55 → lowtier
 *
 * Legacy `computeScore` produced 'trader' (35-54) and 'retail' (<35) as separate values.
 * The processor's DB write uses `type` to set the `tracked_wallets.type` column.
 * For simplicity and to match the active monitoring queries (which only check
 * `type='smart_money'` and `type='whale'`), we collapse anything below 55 to 'lowtier'.
 */
export type WalletClassification = 'smart_money' | 'whale' | 'lowtier';

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Return value of ScoreWalletService.scoreFromBirdeyeAndZerion(). */
export interface WalletScoreResult {
  /** Weighted overall score 0–100. */
  overall: number;
  /** Classification derived from `overall`. */
  classification: WalletClassification;
  /** Per-dimension score breakdown (stored as JSON string in the DB). */
  breakdown: ScoreBreakdown;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Pure-function scoring engine — no DI, no NestJS decorators.
 *
 * Instantiate directly: `new ScoreWalletService()`.
 * The processor creates a singleton instance; no module registration needed.
 */
export class ScoreWalletService {
  /**
   * Compute a smart-money score from Birdeye trader rank, token top-trader
   * stats, and Zerion PnL data.
   *
   * Any or all three inputs may be `null` (e.g. Zerion unavailable for Solana,
   * or Birdeye key not configured). When all three are null, returns `overall:0`
   * with classification `'lowtier'`.
   *
   * This is a faithful port of `computeScore()` in `scripts/score-wallet.js:306-419`
   * (bug-for-bug parity, DoD §I). The only intentional difference: legacy
   * `'trader'` and `'retail'` are collapsed to `'lowtier'`.
   *
   * @param traderRank - Result from BirdeyeAdapter.getTraderRank() or null.
   * @param tokenTopTrader - Result from BirdeyeAdapter.getTokenTopTraders() or null.
   * @param zerionPnl - Result from ZerionAdapter.getPnl() or null.
   */
  scoreFromBirdeyeAndZerion(
    traderRank: TraderRankResult | null,
    tokenTopTrader: TokenTopTrader | null,
    zerionPnl: ZerionPnlResult | null,
  ): WalletScoreResult {
    const scores: ScoreBreakdown = {
      profitability: 0,
      consistency: 0,
      volume: 0,
      activity: 0,
      reputation: 0,
    };

    let dataPoints = 0;

    // -----------------------------------------------------------------------
    // Birdeye trader rank data
    // mirrors scripts/score-wallet.js:318-337
    // -----------------------------------------------------------------------
    if (traderRank) {
      dataPoints++;

      if (traderRank.inTopGainers) {
        // In top gainers = strong signal
        scores.reputation = traderRank.rank <= 10 ? 100 : traderRank.rank <= 25 ? 85 : traderRank.rank <= 50 ? 70 : 55;

        scores.profitability =
          traderRank.pnl > 100_000 ? 100 : traderRank.pnl > 10_000 ? 85 : traderRank.pnl > 1_000 ? 70 : 55;

        scores.volume =
          traderRank.volume > 1_000_000 ? 100 : traderRank.volume > 100_000 ? 80 : traderRank.volume > 10_000 ? 60 : 40;

        scores.activity =
          traderRank.tradeCount > 100 ? 100 : traderRank.tradeCount > 50 ? 80 : traderRank.tradeCount > 10 ? 60 : 40;
      } else {
        // Not in top gainers
        scores.reputation = 15;
      }
    }

    // -----------------------------------------------------------------------
    // Zerion PnL data (EVM only)
    // mirrors scripts/score-wallet.js:340-362
    // -----------------------------------------------------------------------
    if (zerionPnl) {
      dataPoints++;

      const roi =
        zerionPnl.relativeRealizedGain != null
          ? zerionPnl.relativeRealizedGain / 100
          : zerionPnl.totalInvested > 0
            ? zerionPnl.totalPnl / zerionPnl.totalInvested
            : 0;

      const profitScore =
        roi > 5 ? 100 : roi > 2 ? 85 : roi > 1 ? 70 : roi > 0.5 ? 55 : roi > 0.1 ? 40 : roi > 0 ? 25 : 10;

      // Average with Birdeye if both exist — mirrors legacy: "Average with Birdeye if both exist"
      scores.profitability =
        scores.profitability > 0 ? Math.round((scores.profitability + profitScore) / 2) : profitScore;

      // Cost basis indicates portfolio size
      const invested = zerionPnl.totalInvested;
      const sizeScore =
        invested > 1_000_000 ? 100 : invested > 100_000 ? 80 : invested > 10_000 ? 60 : invested > 1_000 ? 40 : 15;
      scores.volume = scores.volume > 0 ? Math.round((scores.volume + sizeScore) / 2) : sizeScore;
    }

    // -----------------------------------------------------------------------
    // Token-specific trader data (bonus)
    // mirrors scripts/score-wallet.js:365-388
    // -----------------------------------------------------------------------
    if (tokenTopTrader?.isTopTrader) {
      dataPoints++;

      // Being a top trader for a specific token is a strong signal
      const bonus = tokenTopTrader.rank <= 5 ? 20 : tokenTopTrader.rank <= 20 ? 10 : 5;
      scores.reputation = Math.min(100, scores.reputation + bonus);

      if (scores.activity === 0) {
        scores.activity = tokenTopTrader.trades > 50 ? 80 : tokenTopTrader.trades > 10 ? 60 : 40;
      }

      // Buy/sell ratio can indicate conviction
      if (tokenTopTrader.buys > 0 && tokenTopTrader.sells > 0) {
        const ratio = tokenTopTrader.volumeBuy / (tokenTopTrader.volumeSell || 1);
        scores.consistency =
          ratio > 2
            ? 70 // heavy accumulator
            : ratio > 1
              ? 60 // net buyer
              : ratio > 0.5
                ? 40 // balanced
                : 30; // net seller
      }
    }

    // -----------------------------------------------------------------------
    // No data at all
    // mirrors scripts/score-wallet.js:389-391
    // -----------------------------------------------------------------------
    if (dataPoints === 0) {
      return {
        overall: 0,
        classification: 'lowtier',
        breakdown: scores,
      };
    }

    // -----------------------------------------------------------------------
    // Weighted overall
    // mirrors scripts/score-wallet.js:393-399
    // -----------------------------------------------------------------------
    const overall = Math.round(
      scores.profitability * 0.3 +
        scores.reputation * 0.25 +
        scores.volume * 0.2 +
        scores.activity * 0.15 +
        scores.consistency * 0.1,
    );

    // -----------------------------------------------------------------------
    // Classification
    // mirrors scripts/score-wallet.js:402-417 with lowtier collapse
    // -----------------------------------------------------------------------
    const classification: WalletClassification = overall >= 75 ? 'smart_money' : overall >= 55 ? 'whale' : 'lowtier';

    return { overall, classification, breakdown: scores };
  }
}
