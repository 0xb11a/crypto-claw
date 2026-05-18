#!/usr/bin/env node
/**
 * cclaw — CryptoClaw API CLI.
 *
 * Commands (P1a originals + P5b-PR1 additions):
 *   positions   list / get / set-onchain-balance
 *   orders      list / get / propose / approve / reject / execute / cancel / retry / history
 *   receipts    list / get / create
 *   alerts      list / get / create / ack / send
 *   heartbeat   list / get / overdue / ping
 *   system      audit / meta {get,set} / cash {get,set} / gas / sync-status
 *   watchlist   list / get / add / update / remove
 *   contracts   list / add
 *   liquidity   list / add
 *   analysis    list / check / cache / clear-expired
 *   wallets     list / unscored / get / add / propose / update-score / remove / signals
 *   logs        executor {list,get,append} / sentinel {list,get,append}
 *               / research {list,get,append} / observer {list,get,append}
 *
 * Reads CCLAW_API_TOKEN and CCLAW_API_BASE from env. Outputs JSON to stdout.
 *
 * SPEC §13 — Commander.js wrapper around the cclaw API.
 *
 * Note: this file intentionally reads process.env directly — it is a CLI
 * entrypoint, not a NestJS module. The ESLint process.env rule is disabled
 * for CLI entrypoints (sdk/cclaw is outside the libs/ scope the rule targets).
 *
 * Three-level Commander nesting (logs → agent → action):
 *   Verified working in Commander v14 using the same pattern as meta (two-level).
 *   logsCmd.command('executor') returns an executorCmd, then
 *   executorCmd.command('list') works identically to metaCmd.command('get').
 *   No fall-back to flat form was needed.
 */

import { Command } from 'commander';

const VERSION = '0.1.0';

// -------------------------------------------------------------------------
// Config helpers
// -------------------------------------------------------------------------

/* eslint-disable no-restricted-syntax */
function getApiBase(): string {
  return (process.env as Record<string, string | undefined>)['CCLAW_API_BASE'] ?? 'http://127.0.0.1:7878';
}

function getApiToken(): string {
  const token = (process.env as Record<string, string | undefined>)['CCLAW_API_TOKEN'];
  if (!token) {
    process.stderr.write('[cclaw] Error: CCLAW_API_TOKEN env var is not set\n');
    process.exit(1);
  }
  return token;
}
/* eslint-enable no-restricted-syntax */

async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const base = getApiBase();
  const token = getApiToken();
  const url = `${base}/v1${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const data: unknown = await res.json();

  if (!res.ok) {
    const errData = data as { error?: { message?: string; code?: string } };
    const msg = errData?.error?.message ?? `HTTP ${res.status}`;
    process.stderr.write(`[cclaw] API error: ${msg}\n`);
    process.exit(1);
  }

  return data as T;
}

function output(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

/** Parse a --json flag value; exits 1 on invalid JSON. */
function parseJsonFlag(raw: string, flagName = '--json'): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    process.stderr.write(`[cclaw] Error: ${flagName} must be valid JSON\n`);
    process.exit(1);
  }
}

// -------------------------------------------------------------------------
// CLI setup
// -------------------------------------------------------------------------

const program = new Command();

program.name('cclaw').description('CryptoClaw API CLI').version(VERSION);

// -------------------------------------------------------------------------
// positions list / get / set-onchain-balance
// -------------------------------------------------------------------------

const positionsCmd = program.command('positions').description('Position operations');

positionsCmd
  .command('list')
  .description('List positions')
  .option('--status <status>', 'Filter by status (open|closed|partial_exit|all)')
  .option('--mode <mode>', 'Portfolio mode (real|paper)', 'real')
  .option('--chain <chain>', 'Filter by chain')
  .option('--limit <n>', 'Maximum results', '50')
  .option('--format <format>', 'Output format (json)', 'json')
  .action(async (opts: { status?: string; mode?: string; chain?: string; limit?: string }) => {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.mode) params.set('mode', opts.mode);
    if (opts.chain) params.set('chain', opts.chain);
    if (opts.limit) params.set('limit', opts.limit);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/positions${query ? '?' + query : ''}`);
    output(data);
  });

positionsCmd
  .command('get')
  .description('Get a position by ID')
  .requiredOption('--id <id>', 'Position ID')
  .option('--mode <mode>', 'Portfolio mode (real|paper)', 'real')
  .action(async (opts: { id: string; mode?: string }) => {
    const params = new URLSearchParams();
    if (opts.mode) params.set('mode', opts.mode);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/positions/${opts.id}${query ? '?' + query : ''}`);
    output(data);
  });

positionsCmd
  .command('set-onchain-balance')
  .description('Set the on-chain balance for a position (sugar for PATCH /positions/:id)')
  .requiredOption('--id <id>', 'Position ID')
  .requiredOption('--balance <balance>', 'On-chain balance (numeric)')
  .option('--mode <mode>', 'Portfolio mode (real|paper)', 'real')
  .action(async (opts: { id: string; balance: string; mode?: string }) => {
    const balance = parseFloat(opts.balance);
    if (!isFinite(balance) || balance < 0) {
      process.stderr.write('[cclaw] Error: --balance must be a non-negative number\n');
      process.exit(1);
    }
    const params = new URLSearchParams();
    if (opts.mode && opts.mode !== 'real') params.set('mode', opts.mode);
    const query = params.toString();
    const data = await apiCall<unknown>('PATCH', `/positions/${opts.id}${query ? '?' + query : ''}`, {
      onchain_balance: balance,
    });
    output(data);
  });

// -------------------------------------------------------------------------
// orders list / get / propose / approve / reject / execute / cancel / retry / history
// -------------------------------------------------------------------------

const ordersCmd = program.command('orders').description('Order operations');

ordersCmd
  .command('list')
  .description('List orders')
  .option('--status <status>', 'Filter by status (pending|approved|executed|...)')
  .option('--action <action>', 'Filter by action (buy|sell)')
  .option('--pending', 'Show pending/approved orders only')
  .option('--limit <n>', 'Maximum results', '50')
  .action(async (opts: { status?: string; action?: string; pending?: boolean; limit?: string }) => {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.action) params.set('action', opts.action);
    if (opts.pending) params.set('pending', 'true');
    if (opts.limit) params.set('limit', opts.limit);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/orders${query ? '?' + query : ''}`);
    output(data);
  });

ordersCmd
  .command('get')
  .description('Get an order by ID')
  .requiredOption('--id <id>', 'Order ID')
  .action(async (opts: { id: string }) => {
    const data = await apiCall<unknown>('GET', `/orders/${opts.id}`);
    output(data);
  });

ordersCmd
  .command('propose')
  .description('Propose a new order')
  .requiredOption('--json <body>', 'JSON body for the order')
  .action(async (opts: { json: string }) => {
    const body = parseJsonFlag(opts.json);
    const data = await apiCall<unknown>('POST', '/orders', body);
    output(data);
  });

ordersCmd
  .command('approve')
  .description('Approve a pending order')
  .requiredOption('--id <id>', 'Order ID')
  .option('--by <identity>', 'Identity approving the order', 'human')
  .action(async (opts: { id: string; by?: string }) => {
    const data = await apiCall<unknown>('POST', `/orders/${opts.id}/approve`, {
      by: opts.by ?? 'human',
    });
    output(data);
  });

ordersCmd
  .command('reject')
  .description('Reject a pending order')
  .requiredOption('--id <id>', 'Order ID')
  .option('--reason <reason>', 'Reason for rejection')
  .action(async (opts: { id: string; reason?: string }) => {
    const data = await apiCall<unknown>('POST', `/orders/${opts.id}/reject`, {
      reason: opts.reason,
    });
    output(data);
  });

ordersCmd
  .command('cancel')
  .description('Cancel an order')
  .requiredOption('--id <id>', 'Order ID')
  .option('--reason <reason>', 'Reason for cancellation')
  .option('--by <identity>', 'Identity cancelling the order')
  .action(async (opts: { id: string; reason?: string; by?: string }) => {
    const body: Record<string, string> = {};
    if (opts.reason) body['reason'] = opts.reason;
    if (opts.by) body['by'] = opts.by;
    const data = await apiCall<unknown>('POST', `/orders/${opts.id}/cancel`, body);
    output(data);
  });

ordersCmd
  .command('retry')
  .description('Retry a failed order')
  .requiredOption('--id <id>', 'Order ID')
  .option('--by <identity>', 'Identity initiating the retry')
  .action(async (opts: { id: string; by?: string }) => {
    const body: Record<string, string> = {};
    if (opts.by) body['by'] = opts.by;
    const data = await apiCall<unknown>('POST', `/orders/${opts.id}/retry`, body);
    output(data);
  });

ordersCmd
  .command('execute')
  .description('Execute an approved order (enqueues BullMQ job or simulates in paper mode)')
  .requiredOption('--id <id>', 'Order ID to execute')
  .action(async (opts: { id: string }) => {
    // POST with empty body — executor uses the order's stored data
    const data = await apiCall<unknown>('POST', `/orders/${opts.id}/execute`, {});
    output(data);
  });

ordersCmd
  .command('history')
  .description('List order history (all statuses, most recent first) — sugar for orders list')
  .option('--status <status>', 'Filter by status (pending|approved|executed|failed|cancelled|rejected|expired)')
  .option('--action <action>', 'Filter by action (buy|sell)')
  .option('--limit <n>', 'Maximum results', '20')
  .action(async (opts: { status?: string; action?: string; limit?: string }) => {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.action) params.set('action', opts.action);
    if (opts.limit) params.set('limit', opts.limit);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/orders${query ? '?' + query : ''}`);
    output(data);
  });

// -------------------------------------------------------------------------
// receipts list / get / create
// -------------------------------------------------------------------------

const receiptsCmd = program.command('receipts').description('Receipt operations');

receiptsCmd
  .command('list')
  .description('List receipts')
  .option('--status <status>', 'Filter by status')
  .option('--mode <mode>', 'Portfolio mode (real|paper)', 'real')
  .option('--limit <n>', 'Maximum results', '50')
  .option('--cursor <cursor>', 'Pagination cursor')
  .action(async (opts: { status?: string; mode?: string; limit?: string; cursor?: string }) => {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.mode) params.set('mode', opts.mode);
    if (opts.limit) params.set('limit', opts.limit);
    if (opts.cursor) params.set('cursor', opts.cursor);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/receipts${query ? '?' + query : ''}`);
    output(data);
  });

receiptsCmd
  .command('get')
  .description('Get a receipt by ID')
  .requiredOption('--id <id>', 'Receipt ID')
  .option('--mode <mode>', 'Portfolio mode (real|paper)', 'real')
  .action(async (opts: { id: string; mode?: string }) => {
    const params = new URLSearchParams();
    if (opts.mode) params.set('mode', opts.mode);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/receipts/${opts.id}${query ? '?' + query : ''}`);
    output(data);
  });

receiptsCmd
  .command('create')
  .description('Create a receipt (executor writes execution records)')
  .requiredOption('--json <body>', 'JSON body for the receipt')
  .action(async (opts: { json: string }) => {
    const body = parseJsonFlag(opts.json);
    const data = await apiCall<unknown>('POST', '/receipts', body);
    output(data);
  });

// -------------------------------------------------------------------------
// alerts list / get / create / ack / send
// -------------------------------------------------------------------------

const alertsCmd = program.command('alerts').description('Alert operations');

alertsCmd
  .command('list')
  .description('List sentinel alerts')
  .option('--unprocessed', 'Show only unprocessed alerts')
  .option('--limit <n>', 'Maximum results', '50')
  .option('--cursor <cursor>', 'Pagination cursor')
  .action(async (opts: { unprocessed?: boolean; limit?: string; cursor?: string }) => {
    const params = new URLSearchParams();
    if (opts.unprocessed) params.set('unprocessed', 'true');
    if (opts.limit) params.set('limit', opts.limit);
    if (opts.cursor) params.set('cursor', opts.cursor);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/alerts${query ? '?' + query : ''}`);
    output(data);
  });

alertsCmd
  .command('get')
  .description('Get an alert by ID')
  .requiredOption('--id <id>', 'Alert ID')
  .action(async (opts: { id: string }) => {
    const data = await apiCall<unknown>('GET', `/alerts/${opts.id}`);
    output(data);
  });

alertsCmd
  .command('create')
  .description('Create a sentinel alert')
  .requiredOption('--json <body>', 'JSON body for the alert')
  .action(async (opts: { json: string }) => {
    const body = parseJsonFlag(opts.json);
    const data = await apiCall<unknown>('POST', '/alerts', body);
    output(data);
  });

alertsCmd
  .command('ack')
  .description('Acknowledge a sentinel alert (idempotent)')
  .requiredOption('--id <id>', 'Alert ID')
  .option('--note <note>', 'Optional acknowledgment note')
  .action(async (opts: { id: string; note?: string }) => {
    const body: Record<string, string> = {};
    if (opts.note) body['note'] = opts.note;
    const data = await apiCall<unknown>('POST', `/alerts/${opts.id}/acknowledge`, body);
    output(data);
  });

alertsCmd
  .command('send')
  .description('Send a Telegram notification (fire-and-forget, 202 accepted)')
  .requiredOption('--type <type>', 'Alert type (e.g. model_failure, emergency_mode, recovered)')
  .requiredOption('--agent <agent>', 'Agent name shown in the alert header (e.g. executor, sentinel)')
  .requiredOption('--message <message>', 'Alert message body (max 4000 chars)')
  .option('--data <json>', 'Optional JSON metadata (stored in audit log, not sent to Telegram)')
  .action(async (opts: { type: string; agent: string; message: string; data?: string }) => {
    const body: Record<string, unknown> = {
      type: opts.type,
      agent: opts.agent,
      message: opts.message,
    };
    if (opts.data !== undefined) {
      body['data'] = parseJsonFlag(opts.data, '--data');
    }
    const data = await apiCall<unknown>('POST', '/alerts/send', body);
    output(data);
  });

// -------------------------------------------------------------------------
// heartbeat list / get / overdue / ping
// -------------------------------------------------------------------------

const heartbeatCmd = program.command('heartbeat').description('Heartbeat operations');

heartbeatCmd
  .command('list')
  .description('List all heartbeat rows')
  .option('--agent <agent>', 'Filter by agent name')
  .action(async (opts: { agent?: string }) => {
    const params = new URLSearchParams();
    if (opts.agent) params.set('agent', opts.agent);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/heartbeat${query ? '?' + query : ''}`);
    output(data);
  });

heartbeatCmd
  .command('get')
  .description('Get heartbeat rows for a specific agent')
  .requiredOption('--agent <agent>', 'Agent name')
  .action(async (opts: { agent: string }) => {
    const data = await apiCall<unknown>('GET', `/heartbeat/${opts.agent}`);
    output(data);
  });

heartbeatCmd
  .command('overdue')
  .description('Get overdue checks for an agent')
  .requiredOption('--agent <agent>', 'Agent name')
  .action(async (opts: { agent: string }) => {
    const data = await apiCall<unknown>('GET', `/heartbeat/${opts.agent}/overdue`);
    output(data);
  });

heartbeatCmd
  .command('ping')
  .description('Ping (update) a heartbeat check')
  .requiredOption('--agent <agent>', 'Agent name')
  .requiredOption('--check <checkType>', 'Check type (e.g. price_check, process_orders)')
  .action(async (opts: { agent: string; check: string }) => {
    const data = await apiCall<unknown>('POST', `/heartbeat/${opts.agent}/${opts.check}/ping`, {});
    output(data);
  });

// -------------------------------------------------------------------------
// system audit / meta {get,set} / cash {get,set} / gas / sync-status
// -------------------------------------------------------------------------

const systemCmd = program.command('system').description('System operations');

// --- system audit ---
systemCmd
  .command('audit')
  .description('Query audit log entries')
  .option('--identity <identity>', 'Filter by identity (e.g. RESEARCH, EXECUTOR)')
  .option('--role <role>', 'Filter by role (agent|dashboard)')
  .option('--method <method>', 'Filter by HTTP method')
  .option('--path <path>', 'Substring match on path')
  .option('--status <status>', 'Filter by HTTP status code')
  .option('--since <since>', 'Return entries from this ISO timestamp')
  .option('--until <until>', 'Return entries up to this ISO timestamp')
  .option('--limit <n>', 'Maximum results', '100')
  .option('--cursor <cursor>', 'Keyset cursor for pagination')
  .action(
    async (opts: {
      identity?: string;
      role?: string;
      method?: string;
      path?: string;
      status?: string;
      since?: string;
      until?: string;
      limit?: string;
      cursor?: string;
    }) => {
      const params = new URLSearchParams();
      if (opts.identity) params.set('identity', opts.identity);
      if (opts.role) params.set('role', opts.role);
      if (opts.method) params.set('method', opts.method);
      if (opts.path) params.set('pathContains', opts.path);
      if (opts.status) params.set('status', opts.status);
      if (opts.since) params.set('since', opts.since);
      if (opts.until) params.set('until', opts.until);
      if (opts.limit) params.set('limit', opts.limit);
      if (opts.cursor) params.set('cursor', opts.cursor);
      const query = params.toString();
      const data = await apiCall<unknown>('GET', `/system/audit${query ? '?' + query : ''}`);
      output(data);
    },
  );

// --- system meta get/set ---
// Nested 'meta' subcommand group — Commander v14 requires the parent be
// registered once; `.command('meta get')` + `.command('meta set')` would
// throw "cannot add command 'meta' as already have command 'meta'" at
// module load and break the entire cclaw binary.
const metaCmd = systemCmd.command('meta').description('Portfolio meta key/value operations');

metaCmd
  .command('get')
  .description('Get a portfolio_meta key/value')
  .requiredOption('--key <key>', 'Meta key to retrieve')
  .action(async (opts: { key: string }) => {
    const data = await apiCall<unknown>('GET', `/system/meta?key=${encodeURIComponent(opts.key)}`);
    output(data);
  });

metaCmd
  .command('set')
  .description('Set a portfolio_meta key/value (writes audit trail)')
  .requiredOption('--key <key>', 'Meta key to set')
  .requiredOption('--value <value>', 'Value to store (stored as string)')
  .action(async (opts: { key: string; value: string }) => {
    const data = await apiCall<unknown>('PATCH', '/system/meta', { key: opts.key, value: opts.value });
    output(data);
  });

// --- system cash get/set ---
// Two GET shapes:
//   cclaw system cash get           → GET /v1/system/cash (all chains)
//   cclaw system cash get --chain X → GET /v1/system/cash/:chain (single chain)
const cashCmd = systemCmd.command('cash').description('Cash balance operations');

cashCmd
  .command('get')
  .description('Get cash balance — all chains or a specific chain')
  .option('--chain <chain>', 'Chain identifier (omit for all-chains breakdown)')
  .action(async (opts: { chain?: string }) => {
    const path = opts.chain ? `/system/cash/${encodeURIComponent(opts.chain)}` : '/system/cash';
    const data = await apiCall<unknown>('GET', path);
    output(data);
  });

cashCmd
  .command('set')
  .description('Set cash balance for a chain (writes audit trail)')
  .requiredOption('--chain <chain>', 'Chain identifier')
  .requiredOption('--amount <amount>', 'Cash amount in USD')
  .action(async (opts: { chain: string; amount: string }) => {
    const amount = parseFloat(opts.amount);
    if (!isFinite(amount) || amount < 0) {
      process.stderr.write('[cclaw] Error: --amount must be a non-negative number\n');
      process.exit(1);
    }
    const data = await apiCall<unknown>('PATCH', '/system/cash', { chain: opts.chain, amount });
    output(data);
  });

// --- system gas ---
systemCmd
  .command('gas')
  .description('Get gas token balance for a chain')
  .requiredOption('--chain <chain>', 'Chain identifier')
  .action(async (opts: { chain: string }) => {
    const data = await apiCall<unknown>('GET', `/system/gas?chain=${encodeURIComponent(opts.chain)}`);
    output(data);
  });

// --- system sync-status ---
systemCmd
  .command('sync-status')
  .description('List portfolio sync history')
  .option('--chain <chain>', 'Filter by chain')
  .option('--limit <n>', 'Maximum results', '20')
  .action(async (opts: { chain?: string; limit?: string }) => {
    const params = new URLSearchParams();
    if (opts.chain) params.set('chain', opts.chain);
    if (opts.limit) params.set('limit', opts.limit);
    const query = params.toString();
    const data = await apiCall<unknown>(`GET`, `/system/sync-status${query ? '?' + query : ''}`);
    output(data);
  });

// --- system portfolio ---
systemCmd
  .command('portfolio')
  .description('Get portfolio snapshot (all chains or a specific chain)')
  .option('--chain <chain>', 'Filter to a single chain (e.g. base, solana)')
  .option('--mode <mode>', 'Portfolio mode override (real|paper)')
  .action(async (opts: { chain?: string; mode?: string }) => {
    const params = new URLSearchParams();
    if (opts.chain) params.set('chain', opts.chain);
    if (opts.mode) params.set('mode', opts.mode);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/system/portfolio${query ? '?' + query : ''}`);
    output(data);
  });

// --- system trade-stats ---
systemCmd
  .command('trade-stats')
  .description('Get aggregated trade statistics')
  .option('--chain <chain>', 'Filter stats to a single chain')
  .option('--mode <mode>', 'Portfolio mode override (real|paper)')
  .action(async (opts: { chain?: string; mode?: string }) => {
    const params = new URLSearchParams();
    if (opts.chain) params.set('chain', opts.chain);
    if (opts.mode) params.set('mode', opts.mode);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/system/trade-stats${query ? '?' + query : ''}`);
    output(data);
  });

// --- system chains ---
systemCmd
  .command('chains')
  .description('List active and all known chains')
  .action(async () => {
    const data = await apiCall<unknown>('GET', '/system/chains');
    output(data);
  });

// --- system chain-config ---
systemCmd
  .command('chain-config')
  .description('Get configuration for a specific chain')
  .requiredOption('--chain <chain>', 'Chain identifier (e.g. base, solana, ethereum)')
  .action(async (opts: { chain: string }) => {
    const data = await apiCall<unknown>('GET', `/system/chains/${encodeURIComponent(opts.chain)}`);
    output(data);
  });

// --- system sync-portfolio ---
systemCmd
  .command('sync-portfolio')
  .description('Enqueue a portfolio reconcile job for a chain (fire-and-forget, 202)')
  .requiredOption('--chain <chain>', 'Chain to reconcile (e.g. base, solana, ethereum)')
  .option('--trigger <trigger>', 'Trigger reason (periodic|post_trade|manual)', 'manual')
  .action(async (opts: { chain: string; trigger?: string }) => {
    const body: Record<string, string> = { chain: opts.chain };
    if (opts.trigger) body['trigger'] = opts.trigger;
    const data = await apiCall<unknown>('POST', '/system/sync-portfolio', body);
    output(data);
  });

// -------------------------------------------------------------------------
// watchlist list / get / add / update / remove
// -------------------------------------------------------------------------

const watchlistCmd = program.command('watchlist').description('Watchlist operations');

watchlistCmd
  .command('list')
  .description('List watchlist entries')
  .option('--status <status>', 'Filter by status (watching|entry_hit|expired|removed|all)')
  .option('--active', 'Shorthand for --status watching')
  .action(async (opts: { status?: string; active?: boolean }) => {
    const params = new URLSearchParams();
    const status = opts.active ? 'watching' : opts.status;
    if (status) params.set('status', status);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/watchlist${query ? '?' + query : ''}`);
    output(data);
  });

watchlistCmd
  .command('get')
  .description('Get a watchlist entry by ID')
  .requiredOption('--id <id>', 'Watchlist entry ID')
  .action(async (opts: { id: string }) => {
    const data = await apiCall<unknown>('GET', `/watchlist/${opts.id}`);
    output(data);
  });

watchlistCmd
  .command('add')
  .description('Add a token to the watchlist')
  .requiredOption('--json <json>', 'JSON body (AddWatchlistDto)')
  .action(async (opts: { json: string }) => {
    const body = parseJsonFlag(opts.json);
    const data = await apiCall<unknown>('POST', '/watchlist', body);
    output(data);
  });

watchlistCmd
  .command('update')
  .description('Update a watchlist entry')
  .requiredOption('--id <id>', 'Watchlist entry ID')
  .requiredOption('--json <json>', 'JSON body (UpdateWatchlistDto)')
  .action(async (opts: { id: string; json: string }) => {
    const body = parseJsonFlag(opts.json);
    const data = await apiCall<unknown>('PATCH', `/watchlist/${opts.id}`, body);
    output(data);
  });

watchlistCmd
  .command('remove')
  .description('Soft-delete a watchlist entry (sets status=removed)')
  .requiredOption('--id <id>', 'Watchlist entry ID')
  .action(async (opts: { id: string }) => {
    const data = await apiCall<unknown>('DELETE', `/watchlist/${opts.id}`);
    output(data);
  });

// -------------------------------------------------------------------------
// contracts list / add
// Controller path: /v1/contracts/snapshots
// -------------------------------------------------------------------------

const contractsCmd = program.command('contracts').description('Contract snapshot operations');

contractsCmd
  .command('list')
  .description('List recent contract safety snapshots')
  .requiredOption('--address <address>', 'Contract address')
  .requiredOption('--chain <chain>', 'Chain identifier')
  .option('--limit <n>', 'Maximum results', '5')
  .action(async (opts: { address: string; chain: string; limit?: string }) => {
    const params = new URLSearchParams();
    params.set('address', opts.address);
    params.set('chain', opts.chain);
    if (opts.limit) params.set('limit', opts.limit);
    const data = await apiCall<unknown>('GET', `/contracts/snapshots?${params.toString()}`);
    output(data);
  });

contractsCmd
  .command('add')
  .description('Add a contract safety snapshot')
  .requiredOption('--address <address>', 'Contract address')
  .requiredOption('--chain <chain>', 'Chain identifier')
  .requiredOption('--json <json>', 'Raw JSON string of safety check data (max 65KB)')
  .action(async (opts: { address: string; chain: string; json: string }) => {
    // safety_data field is the raw JSON string itself (not parsed) per AddContractSnapshotDto
    const data = await apiCall<unknown>('POST', '/contracts/snapshots', {
      address: opts.address,
      chain: opts.chain,
      json: opts.json,
    });
    output(data);
  });

// -------------------------------------------------------------------------
// liquidity list / add
// -------------------------------------------------------------------------

const liquidityCmd = program.command('liquidity').description('Liquidity snapshot operations');

liquidityCmd
  .command('list')
  .description('List liquidity snapshots')
  .option('--address <address>', 'Filter by contract address')
  .option('--chain <chain>', 'Filter by chain')
  .option('--limit <n>', 'Maximum results', '2')
  .action(async (opts: { address?: string; chain?: string; limit?: string }) => {
    const params = new URLSearchParams();
    if (opts.address) params.set('address', opts.address);
    if (opts.chain) params.set('chain', opts.chain);
    if (opts.limit) params.set('limit', opts.limit);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/liquidity${query ? '?' + query : ''}`);
    output(data);
  });

liquidityCmd
  .command('add')
  .description('Add a liquidity snapshot')
  .requiredOption('--address <address>', 'Token or pool contract address')
  .requiredOption('--chain <chain>', 'Chain identifier')
  .requiredOption('--liquidity <amount>', 'Liquidity in USD (>= 0)')
  .action(async (opts: { address: string; chain: string; liquidity: string }) => {
    const liquidity_usd = parseFloat(opts.liquidity);
    if (!isFinite(liquidity_usd) || liquidity_usd < 0) {
      process.stderr.write('[cclaw] Error: --liquidity must be a non-negative number\n');
      process.exit(1);
    }
    const data = await apiCall<unknown>('POST', '/liquidity', {
      address: opts.address,
      chain: opts.chain,
      liquidity_usd,
    });
    output(data);
  });

// -------------------------------------------------------------------------
// analysis list / check / cache / clear-expired
// Controller path: /v1/analysis-cache
// -------------------------------------------------------------------------

const analysisCmd = program.command('analysis').description('Analysis cache operations');

analysisCmd
  .command('list')
  .description('List non-expired analysis cache entries')
  .option('--limit <n>', 'Maximum results', '50')
  .action(async (opts: { limit?: string }) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', opts.limit);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/analysis-cache${query ? '?' + query : ''}`);
    output(data);
  });

analysisCmd
  .command('check')
  .description('Check token cache status (returns 404 if no non-expired entry)')
  .requiredOption('--address <address>', 'Token contract address')
  .requiredOption('--chain <chain>', 'Chain identifier')
  .action(async (opts: { address: string; chain: string }) => {
    const params = new URLSearchParams();
    params.set('address', opts.address);
    params.set('chain', opts.chain);
    const data = await apiCall<unknown>('GET', `/analysis-cache/check?${params.toString()}`);
    output(data);
  });

analysisCmd
  .command('cache')
  .description('Upsert a token analysis cache entry')
  .requiredOption('--json <json>', 'JSON body (CacheAnalysisDto)')
  .action(async (opts: { json: string }) => {
    const body = parseJsonFlag(opts.json);
    const data = await apiCall<unknown>('POST', '/analysis-cache', body);
    output(data);
  });

analysisCmd
  .command('clear-expired')
  .description('Delete all expired analysis cache entries')
  .action(async () => {
    const data = await apiCall<unknown>('DELETE', '/analysis-cache/expired');
    output(data);
  });

// -------------------------------------------------------------------------
// wallets list / unscored / get / add / propose / update-score / remove / signals
// -------------------------------------------------------------------------

const walletsCmd = program.command('wallets').description('Tracked wallet operations');

walletsCmd
  .command('list')
  .description('List tracked wallets')
  .option('--status <status>', 'Filter by status (proposed|scoring|scored|failed)')
  .option('--type <type>', 'Filter by type (smart_money|dev|whale|deployer|trader|retail)')
  .option('--chain <chain>', 'Filter by chain')
  .option('--limit <n>', 'Maximum results', '100')
  .action(async (opts: { status?: string; type?: string; chain?: string; limit?: string }) => {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.type) params.set('type', opts.type);
    if (opts.chain) params.set('chain', opts.chain);
    if (opts.limit) params.set('limit', opts.limit);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/wallets${query ? '?' + query : ''}`);
    output(data);
  });

walletsCmd
  .command('unscored')
  .description('List wallets pending scoring (proposed or failed with retry_count < 3)')
  .option('--limit <n>', 'Maximum results', '5')
  .action(async (opts: { limit?: string }) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', opts.limit);
    const query = params.toString();
    const data = await apiCall<unknown>('GET', `/wallets/unscored${query ? '?' + query : ''}`);
    output(data);
  });

walletsCmd
  .command('get')
  .description('Get a tracked wallet by address and chain')
  .requiredOption('--address <address>', 'Wallet address')
  .requiredOption('--chain <chain>', 'Chain identifier')
  .action(async (opts: { address: string; chain: string }) => {
    const data = await apiCall<unknown>('GET', `/wallets/${opts.address}/${opts.chain}`);
    output(data);
  });

walletsCmd
  .command('add')
  .description('Add or replace a tracked wallet (INSERT OR REPLACE)')
  .requiredOption('--json <json>', 'JSON body (AddTrackedWalletDto)')
  .action(async (opts: { json: string }) => {
    const body = parseJsonFlag(opts.json);
    const data = await apiCall<unknown>('POST', '/wallets', body);
    output(data);
  });

walletsCmd
  .command('propose')
  .description('Propose a wallet for scoring (INSERT OR IGNORE — idempotent)')
  .requiredOption('--json <json>', 'JSON body (ProposeWalletDto)')
  .action(async (opts: { json: string }) => {
    const body = parseJsonFlag(opts.json);
    const data = await apiCall<unknown>('POST', '/wallets/propose', body);
    output(data);
  });

walletsCmd
  .command('update-score')
  .description('Update wallet score and status')
  .requiredOption('--address <address>', 'Wallet address')
  .requiredOption('--chain <chain>', 'Chain identifier')
  .requiredOption('--json <json>', 'JSON body (UpdateWalletScoreDto)')
  .action(async (opts: { address: string; chain: string; json: string }) => {
    const body = parseJsonFlag(opts.json);
    const data = await apiCall<unknown>('PATCH', `/wallets/${opts.address}/${opts.chain}/score`, body);
    output(data);
  });

walletsCmd
  .command('remove')
  .description('Remove a tracked wallet')
  .requiredOption('--address <address>', 'Wallet address')
  .requiredOption('--chain <chain>', 'Chain identifier')
  .action(async (opts: { address: string; chain: string }) => {
    const data = await apiCall<unknown>('DELETE', `/wallets/${opts.address}/${opts.chain}`);
    output(data);
  });

walletsCmd
  .command('signals')
  .description('Get smart-money signals from the signals table')
  .option('--since <window>', 'Time window (e.g. 35m, 2h, 1d)', '35m')
  .option('--action <action>', 'Filter by action (buy|sell)')
  .option('--chain <chain>', 'Filter by chain')
  .option('--group-by <field>', 'Group results (use "token" to aggregate by token address)')
  .option('--min-wallets <n>', 'Minimum distinct wallets (requires --group-by token)', '0')
  .option('--tokens-in-positions', 'Only return signals for tokens in open positions')
  .option('--limit <n>', 'Maximum results', '100')
  .action(
    async (opts: {
      since?: string;
      action?: string;
      chain?: string;
      groupBy?: string;
      minWallets?: string;
      tokensInPositions?: boolean;
      limit?: string;
    }) => {
      const params = new URLSearchParams();
      if (opts.since) params.set('since', opts.since);
      if (opts.action) params.set('action', opts.action);
      if (opts.chain) params.set('chain', opts.chain);
      // CLI --group-by maps to snake_case query param group_by (DTO field name)
      if (opts.groupBy) params.set('group_by', opts.groupBy);
      if (opts.minWallets) params.set('min_wallets', opts.minWallets);
      if (opts.tokensInPositions) params.set('tokens_in_positions', 'true');
      if (opts.limit) params.set('limit', opts.limit);
      const data = await apiCall<unknown>('GET', `/wallets/signals?${params.toString()}`);
      output(data);
    },
  );

// -------------------------------------------------------------------------
// logs {executor|sentinel|research|observer} {list|get|append}
//
// Three-level Commander nesting: program → logsCmd → agentCmd → actionCmd
// Verified working in Commander v14: the same pattern as program → systemCmd →
// metaCmd → subcommand. Each level returns a Command instance that can have
// further .command() children attached.
// -------------------------------------------------------------------------

const logsCmd = program.command('logs').description('Agent log operations');

// Helper to build the three list/get/append subcommands for each agent log.
// agentName: 'executor' | 'sentinel' | 'research' | 'observer'
// apiPrefix: path under /v1/logs/<agentName>
function addAgentLogCommands(agentName: string, description: string): void {
  const agentCmd = logsCmd.command(agentName).description(description);

  agentCmd
    .command('list')
    .description(`List recent ${agentName} log rows`)
    .option('--limit <n>', 'Maximum results', '50')
    .option('--since <iso>', 'Return rows created at or after this ISO-8601 timestamp')
    .option('--status <status>', 'Filter by status (ok|warn|error)')
    .action(async (opts: { limit?: string; since?: string; status?: string }) => {
      const params = new URLSearchParams();
      if (opts.limit) params.set('limit', opts.limit);
      if (opts.since) params.set('since', opts.since);
      if (opts.status) params.set('status', opts.status);
      const query = params.toString();
      const data = await apiCall<unknown>('GET', `/logs/${agentName}${query ? '?' + query : ''}`);
      output(data);
    });

  agentCmd
    .command('get')
    .description(`Get a ${agentName} log row by ID`)
    .requiredOption('--id <id>', 'Row integer ID')
    .action(async (opts: { id: string }) => {
      const data = await apiCall<unknown>('GET', `/logs/${agentName}/${opts.id}`);
      output(data);
    });

  agentCmd
    .command('append')
    .description(`Append a ${agentName} log row`)
    .requiredOption(
      '--json <json>',
      `JSON body (Append${agentName.charAt(0).toUpperCase() + agentName.slice(1)}LogDto)`,
    )
    .action(async (opts: { json: string }) => {
      const body = parseJsonFlag(opts.json);
      const data = await apiCall<unknown>('POST', `/logs/${agentName}`, body);
      output(data);
    });
}

addAgentLogCommands('executor', 'Executor agent log operations');
addAgentLogCommands('sentinel', 'Sentinel agent log operations');
addAgentLogCommands('research', 'Research agent log operations');
addAgentLogCommands('observer', 'Observer agent log operations');

// -------------------------------------------------------------------------
// Run
// -------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`[cclaw] Error: ${String(err)}\n`);
  process.exit(1);
});
