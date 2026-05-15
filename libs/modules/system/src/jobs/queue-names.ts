/**
 * queue-names.ts — Canonical queue naming for portfolio-report BullMQ queue.
 *
 * The portfolio-report queue is a global singleton — it aggregates positions
 * across all chains and sends a daily Telegram digest. ADR-0024 per-Safe
 * concurrency does not apply (no on-chain writes).
 *
 * Cadence: daily at configurable UTC hour (default: midnight) via
 * `PORTFOLIO_REPORT_HOUR` env var. Matches `entrypoint.sh:run_portfolio_report_loop`
 * (DoD §I — parity). Per [OPEN-5]: single-shot at configured hour (not hourly poll).
 *
 * P3g2 plan, Queue topology:
 *   portfolio-report: once per day at PORTFOLIO_REPORT_HOUR (cron: "0 H * * *")
 */

/** BullMQ queue name for the portfolio-report job (P3g2 PR-E). */
export const PORTFOLIO_REPORT_QUEUE = 'portfolio-report' as const;

/**
 * Default BullMQ job options for the portfolio-report queue.
 *
 * Retry policy mirrors P3g1: 2 attempts total, fixed 60 s backoff.
 * Completed jobs: retain last 50. Failed jobs: retain last 20.
 */
export const PORTFOLIO_REPORT_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'fixed' as const, delay: 60_000 },
  removeOnComplete: 50,
  removeOnFail: 20,
} as const;
