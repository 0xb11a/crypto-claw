// ============================================================
// order-approval.js — Decide whether a new order should be
// auto-approved at write time.
//
// Defangs threat #30 (AUTO_APPROVE_BUY=true + prompt-injected
// Research → unbounded buy at attacker CA). PR 1.5 hardening:
//
//   1. AUTO_APPROVE_BUY only takes effect outside paper mode when a
//      positive AUTO_APPROVE_BUY_MAX_USD is set. If the cap is
//      missing, auto-approve silently downgrades to human approval
//      (the entrypoint also fails closed at boot, so this is a
//      defense-in-depth check inside db-query.js).
//
//   2. Even with the cap configured, orders whose USD amount exceeds
//      the cap fall back to status='pending' with a downgradedReason
//      explaining why. The operator gets the proposal in Telegram and
//      decides manually.
//
// Sells are unaffected (sentinel-approved as before).
// Paper-mode buys are unaffected (paper_mode-approved as before).
// ============================================================

/**
 * @param {object} input
 * @param {string} input.action  'buy' or 'sell'
 * @param {number|string} input.amount  USD amount of the order
 * @param {object} [env]  Environment vars (defaults to process.env)
 * @returns {{ status: 'approved'|'pending', approvedBy: string|null, downgradedReason: string|null }}
 */
export function determineOrderApproval({ action, amount }, env = process.env) {
  const isSell = action === 'sell';
  const isPaper = env.PAPER_MODE === 'true';
  const isAutoBuyEnv = env.AUTO_APPROVE_BUY === 'true';

  // Sells: always sentinel-approved.
  if (isSell) {
    return { status: 'approved', approvedBy: 'sentinel', downgradedReason: null };
  }

  // Paper buys: always paper_mode-approved.
  if (isPaper) {
    return { status: 'approved', approvedBy: 'paper_mode', downgradedReason: null };
  }

  // Real buys with AUTO_APPROVE_BUY off: require human approval.
  if (!isAutoBuyEnv) {
    return { status: 'pending', approvedBy: null, downgradedReason: null };
  }

  // Real buys with AUTO_APPROVE_BUY on. Cap MUST be configured.
  const capRaw = env.AUTO_APPROVE_BUY_MAX_USD;
  const cap = parseFloat(capRaw ?? '');
  if (!Number.isFinite(cap) || cap <= 0) {
    return {
      status: 'pending',
      approvedBy: null,
      downgradedReason: 'AUTO_APPROVE_BUY=true but AUTO_APPROVE_BUY_MAX_USD not configured (cap missing or <= 0)',
    };
  }

  // Cap is configured — check the order amount.
  const amt = parseFloat(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return {
      status: 'pending',
      approvedBy: null,
      downgradedReason: `invalid amount '${amount}' — refusing auto-approve`,
    };
  }
  if (amt > cap) {
    return {
      status: 'pending',
      approvedBy: null,
      downgradedReason: `amount $${amt} exceeds AUTO_APPROVE_BUY_MAX_USD $${cap}`,
    };
  }

  // All gates passed — auto-approve.
  return { status: 'approved', approvedBy: 'auto', downgradedReason: null };
}
