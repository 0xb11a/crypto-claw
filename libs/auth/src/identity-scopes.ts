import type { IdentityName } from './identity-registry.js';

/**
 * Per-identity route-scope definitions (P7, ADR-0009 addendum).
 *
 * Each entry is a ReadonlyArray of `'METHOD /path-pattern'` strings or the
 * bare wildcard `'*'`. The IdentityGuard reads these at boot time and makes
 * the scope set available for per-request checks.
 *
 * Design invariants (ADR-0009 addendum, plan Decision 5–7):
 * - WORKER and SCHEDULER have empty scope sets: no inbound HTTP today.
 *   Presenting either token causes a 403 on every route in enforce mode.
 * - DASHBOARD uses `'*'` because the guard enforces the role boundary
 *   (only GET methods are available via @Roles('dashboard')) — the scope
 *   set can be permissive.
 * - LOOP is a superset of all four LLM agents: it covers entrypoint.sh
 *   background loops and retained scripts. In shadow mode this is a no-op;
 *   in enforce mode it replaces the shared LOOP token used by all agents
 *   until PR-B plumbs per-agent tokens.
 * - EXECUTOR (identity ≠ apps/executor subprocess) covers order-execution
 *   reads/writes, receipts, logs, heartbeat, positions balance update, and
 *   alerts. It cannot propose, approve, reject, or cancel orders.
 *
 * The path patterns here are informational documentation; the runtime
 * enforcement is done by `IdentityGuard` reading `@Identities(...)` metadata.
 * This constant is used only to populate `IdentityRegistry.scopes` for
 * observability (future: PR-C boot-check cross-reference).
 */
export const IDENTITY_SCOPES: Readonly<Record<IdentityName, ReadonlyArray<string>>> = {
  RESEARCH: [
    'GET /v1/orders',
    'GET /v1/orders/:id',
    'POST /v1/orders',
    'POST /v1/orders/:id/approve',
    'POST /v1/orders/:id/reject',
    'POST /v1/orders/:id/cancel',
    'POST /v1/orders/:id/retry',
    'GET /v1/positions',
    'GET /v1/positions/:id',
    'POST /v1/positions',
    'PATCH /v1/positions/:id',
    'POST /v1/positions/:id/close',
    'DELETE /v1/positions/:id',
    'GET /v1/receipts',
    'GET /v1/receipts/:id',
    'GET /v1/alerts',
    'GET /v1/alerts/:id',
    'POST /v1/alerts',
    'POST /v1/alerts/:id/acknowledge',
    'POST /v1/alerts/send',
    'GET /v1/watchlist',
    'GET /v1/watchlist/:id',
    'POST /v1/watchlist',
    'PATCH /v1/watchlist/:id',
    'DELETE /v1/watchlist/:id',
    'GET /v1/wallets',
    'GET /v1/wallets/unscored',
    'GET /v1/wallets/:address/:chain',
    'POST /v1/wallets',
    'POST /v1/wallets/propose',
    'PATCH /v1/wallets/:address/:chain/score',
    'DELETE /v1/wallets/:address/:chain',
    'GET /v1/wallets/signals',
    'GET /v1/liquidity',
    'POST /v1/liquidity',
    'GET /v1/contracts/snapshots',
    'POST /v1/contracts/snapshots',
    'GET /v1/heartbeat',
    'GET /v1/heartbeat/:agent',
    'GET /v1/heartbeat/:agent/overdue',
    'POST /v1/heartbeat/:agent/:checkType/ping',
    'GET /v1/logs/research',
    'GET /v1/logs/research/:id',
    'POST /v1/logs/research',
    'GET /v1/logs/sentinel',
    'GET /v1/logs/sentinel/:id',
    'GET /v1/logs/executor',
    'GET /v1/logs/executor/:id',
    'GET /v1/logs/observer',
    'GET /v1/logs/observer/:id',
    'GET /v1/analysis-cache',
    'POST /v1/analysis-cache',
    'GET /v1/analysis-cache/check',
    'DELETE /v1/analysis-cache/expired',
    'GET /v1/system/cash',
    'GET /v1/system/cash/:chain',
    'GET /v1/system/gas',
    'GET /v1/system/meta',
    'GET /v1/system/portfolio',
    'GET /v1/system/trade-stats',
    'GET /v1/system/chains',
    'GET /v1/system/chains/:chain',
    'GET /v1/system/sync-status',
    'GET /v1/system/audit',
    'GET /v1/system/audit/:id',
    // NOTE: PATCH /v1/system/cash is intentionally absent from RESEARCH scope.
    // Cash derives from executor receipts, not direct agent writes (auditor suggestion #3,
    // P7 PR-C1). RESEARCH can read cash; only EXECUTOR and LOOP can write it.
  ],

  SENTINEL: [
    'GET /v1/orders',
    'GET /v1/orders/:id',
    'POST /v1/orders',
    'POST /v1/orders/:id/cancel',
    'GET /v1/positions',
    'GET /v1/positions/:id',
    'GET /v1/receipts',
    'GET /v1/receipts/:id',
    'GET /v1/alerts',
    'GET /v1/alerts/:id',
    'POST /v1/alerts',
    'POST /v1/alerts/:id/acknowledge',
    'POST /v1/alerts/send',
    'GET /v1/wallets',
    'GET /v1/wallets/signals',
    'GET /v1/heartbeat',
    'GET /v1/heartbeat/:agent',
    'GET /v1/heartbeat/:agent/overdue',
    'POST /v1/heartbeat/:agent/:checkType/ping',
    'GET /v1/logs/sentinel',
    'GET /v1/logs/sentinel/:id',
    'POST /v1/logs/sentinel',
    'GET /v1/analysis-cache',
    'GET /v1/analysis-cache/check',
    'GET /v1/system/cash',
    'GET /v1/system/cash/:chain',
    'GET /v1/system/portfolio',
    'GET /v1/system/trade-stats',
    'GET /v1/system/chains',
    'GET /v1/system/chains/:chain',
    'GET /v1/system/sync-status',
  ],

  EXECUTOR: [
    'GET /v1/orders',
    'GET /v1/orders/:id',
    'POST /v1/orders/:id/execute',
    'GET /v1/receipts',
    'GET /v1/receipts/:id',
    'POST /v1/receipts',
    'GET /v1/alerts',
    'GET /v1/alerts/:id',
    'POST /v1/alerts/send',
    'GET /v1/positions',
    'GET /v1/positions/:id',
    'PATCH /v1/positions/:id',
    'GET /v1/heartbeat',
    'GET /v1/heartbeat/:agent',
    'GET /v1/heartbeat/:agent/overdue',
    'POST /v1/heartbeat/:agent/:checkType/ping',
    'GET /v1/logs/executor',
    'GET /v1/logs/executor/:id',
    'POST /v1/logs/executor',
    'GET /v1/system/cash',
    'GET /v1/system/cash/:chain',
    'PATCH /v1/system/cash',
    'GET /v1/system/chains',
    'GET /v1/system/chains/:chain',
  ],

  OBSERVER: [
    'GET /v1/orders',
    'GET /v1/orders/:id',
    'GET /v1/positions',
    'GET /v1/positions/:id',
    'GET /v1/receipts',
    'GET /v1/receipts/:id',
    'GET /v1/alerts',
    'GET /v1/alerts/:id',
    'POST /v1/alerts/send',
    'GET /v1/heartbeat',
    'GET /v1/heartbeat/:agent',
    'GET /v1/heartbeat/:agent/overdue',
    'GET /v1/logs/research',
    'GET /v1/logs/research/:id',
    'GET /v1/logs/sentinel',
    'GET /v1/logs/sentinel/:id',
    'GET /v1/logs/executor',
    'GET /v1/logs/executor/:id',
    'GET /v1/logs/observer',
    'GET /v1/logs/observer/:id',
    'POST /v1/logs/observer',
    'GET /v1/system/cash',
    'GET /v1/system/portfolio',
    'GET /v1/system/trade-stats',
    'GET /v1/system/chains',
    'GET /v1/system/audit',
    'GET /v1/system/audit/:id',
  ],

  /**
   * LOOP: superset — covers entrypoint.sh background loops and retained
   * scripts. In shadow mode (PR-A) this is the token all four LLM agents
   * actually use (gateway wires CCLAW_API_TOKEN=${LOOP_API_KEY}).
   * PR-B plumbs per-agent tokens; at that point LOOP becomes the background-
   * loop-only token (paper-seed, memory-backup, etc).
   */
  LOOP: ['*'],

  /**
   * WORKER: no inbound HTTP calls from apps/worker to apps/api.
   * Empty scope → 403 on every route in enforce mode (defense-in-depth).
   */
  WORKER: [],

  /**
   * SCHEDULER: no inbound HTTP calls from apps/scheduler to apps/api.
   * Empty scope → 403 on every route in enforce mode (defense-in-depth).
   */
  SCHEDULER: [],

  /**
   * DASHBOARD: read-only role. The role boundary (GET-only routes via
   * @Roles('dashboard')) is enforced by RolesGuard. Wildcard scope here
   * avoids duplicating the route list; RolesGuard is the enforcement layer.
   */
  DASHBOARD: ['*'],
};
