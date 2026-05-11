#!/usr/bin/env node
/**
 * cclaw — CryptoClaw API CLI.
 *
 * 7 commands for P1a: positions {list,get} and orders {list,get,propose,approve,reject}.
 * Reads CCLAW_API_TOKEN and CCLAW_API_BASE from env. Outputs JSON to stdout.
 *
 * SPEC §13 — Commander.js wrapper around the cclaw API.
 *
 * Note: this file intentionally reads process.env directly — it is a CLI
 * entrypoint, not a NestJS module. The ESLint process.env rule is disabled
 * for CLI entrypoints (sdk/cclaw is outside the libs/ scope the rule targets).
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

// -------------------------------------------------------------------------
// CLI setup
// -------------------------------------------------------------------------

const program = new Command();

program.name('cclaw').description('CryptoClaw API CLI').version(VERSION);

// -------------------------------------------------------------------------
// positions list
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

// -------------------------------------------------------------------------
// orders
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
    let body: unknown;
    try {
      body = JSON.parse(opts.json);
    } catch {
      process.stderr.write('[cclaw] Error: --json must be valid JSON\n');
      process.exit(1);
    }
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

// -------------------------------------------------------------------------
// receipts
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
    let body: unknown;
    try {
      body = JSON.parse(opts.json);
    } catch {
      process.stderr.write('[cclaw] Error: --json must be valid JSON\n');
      process.exit(1);
    }
    const data = await apiCall<unknown>('POST', '/receipts', body);
    output(data);
  });

// -------------------------------------------------------------------------
// alerts
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
    let body: unknown;
    try {
      body = JSON.parse(opts.json);
    } catch {
      process.stderr.write('[cclaw] Error: --json must be valid JSON\n');
      process.exit(1);
    }
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

// -------------------------------------------------------------------------
// heartbeat
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
// system (audit)
// -------------------------------------------------------------------------

const systemCmd = program.command('system').description('System operations');

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

// -------------------------------------------------------------------------
// Run
// -------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`[cclaw] Error: ${String(err)}\n`);
  process.exit(1);
});
