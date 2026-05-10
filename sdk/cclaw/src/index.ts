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
// Run
// -------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`[cclaw] Error: ${String(err)}\n`);
  process.exit(1);
});
