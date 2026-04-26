#!/usr/bin/env node
/**
 * send-alert.js — Send alerts via OpenClaw message send (Telegram)
 *
 * Usage:
 *   node scripts/send-alert.js --type <type> --agent <agent> --message "<text>"
 *
 * Types:
 *   model_failure, emergency_mode, recovered, trade_proposal, trade_executed,
 *   trade_failed, sell_triggered, sentinel_alert_followup, rug_warning,
 *   signer_low_balance, system_health, heartbeat_summary, portfolio_daily,
 *   rebalance_event
 *
 * Env vars:
 *   TELEGRAM_CHAT_ID      — Supergroup/chat ID for alerts
 *   SAFE_ID               — Fund identifier (included in alert)
 *   TG_TOPIC_RESEARCH     — Forum topic thread ID for Research
 *   TG_TOPIC_SENTINEL     — Forum topic thread ID for Sentinel
 *   TG_TOPIC_EXECUTOR     — Forum topic thread ID for Executor
 *   TG_TOPIC_ALERTS       — Forum topic thread ID for Alerts (urgent)
 *   TG_TOPIC_SYSTEM       — Forum topic thread ID for System
 *   TG_TOPIC_OBSERVER     — Forum topic thread ID for Observer
 *   TG_TOPIC_PORTFOLIO    — Forum topic thread ID for Portfolio
 *
 * Uses `openclaw message send` for delivery (native OpenClaw integration).
 * Falls back to direct Telegram Bot API if TELEGRAM_BOT_TOKEN is set and
 * openclaw CLI is unavailable.
 *
 * Exits 0 even on failure (alerting should never block the main loop).
 * Output: JSON to stdout with { status, type, agent }
 */

import 'dotenv/config';
import { log } from './log.js';
import { execFileSync } from 'node:child_process';

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

// Alert type → topic env var mapping
const TOPIC_MAP = {
  trade_proposal: 'TG_TOPIC_RESEARCH',
  sentinel_alert_followup: 'TG_TOPIC_RESEARCH',
  sell_triggered: 'TG_TOPIC_SENTINEL',
  trade_executed: 'TG_TOPIC_EXECUTOR',
  trade_failed: 'TG_TOPIC_EXECUTOR',
  trade_retry: 'TG_TOPIC_EXECUTOR',
  model_failure: 'TG_TOPIC_ALERTS',
  emergency_mode: 'TG_TOPIC_ALERTS',
  rug_warning: 'TG_TOPIC_ALERTS',
  signer_low_balance: 'TG_TOPIC_ALERTS',
  recovered: 'TG_TOPIC_SYSTEM',
  system_health: 'TG_TOPIC_OBSERVER',
  heartbeat_summary: 'TG_TOPIC_SYSTEM',
  portfolio_daily: 'TG_TOPIC_PORTFOLIO',
  rebalance_event: 'TG_TOPIC_PORTFOLIO',
};

const EMOJI_MAP = {
  recovered: '\u2705',
  trade_proposal: '\uD83D\uDCCA',
  trade_executed: '\u2705',
  trade_failed: '\u274C',
  trade_retry: '\uD83D\uDD04',
  sell_triggered: '\uD83D\uDEA8',
  sentinel_alert_followup: '\uD83D\uDCDD',
  model_failure: '\u26A0\uFE0F',
  emergency_mode: '\u26A0\uFE0F',
  rug_warning: '\uD83D\uDEA8',
  signer_low_balance: '\u26FD',
  system_health: '\uD83D\uDCE1',
  heartbeat_summary: '\uD83D\uDCE1',
  portfolio_daily: '\uD83D\uDCB0',
  rebalance_event: '\u2696\uFE0F',
};

const SEP = '\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015';

const TYPE_LABELS = {
  trade_executed: 'TRADE EXECUTED',
  trade_failed: 'TRADE FAILED',
  trade_retry: 'RETRY',
  trade_proposal: 'TRADE PROPOSAL',
  sell_triggered: 'SELL TRIGGERED',
  sentinel_alert_followup: 'SENTINEL FOLLOW-UP',
  model_failure: 'MODEL FAILURE',
  emergency_mode: 'EMERGENCY MODE',
  recovered: 'RECOVERED',
  rug_warning: 'RUG WARNING',
  signer_low_balance: 'LOW SIGNER BALANCE',
  system_health: 'SYSTEM HEALTH',
  heartbeat_summary: 'HEARTBEAT',
  portfolio_daily: 'PORTFOLIO REPORT',
  rebalance_event: 'REBALANCE',
};

function resolveThreadId(type) {
  const envVar = TOPIC_MAP[type];
  return envVar ? process.env[envVar] || null : null;
}

// ============================================================
// Per-type formatters
// ============================================================

function formatTradeExecuted(emoji, message, safeId) {
  return `${emoji} TRADE EXECUTED\n${SEP}\n${message}\n${SEP}\nFund: ${safeId}`;
}

function formatTradeFailed(emoji, message, safeId) {
  // Split on first ": " to separate "BUY SYMBOL" from the reason
  const colonIdx = message.indexOf(': ');
  if (colonIdx !== -1) {
    const header = message.slice(0, colonIdx);
    const reason = message.slice(colonIdx + 2);
    return `${emoji} TRADE FAILED\n${SEP}\n${header}\n${reason}\n${SEP}\nFund: ${safeId}`;
  }
  return `${emoji} TRADE FAILED\n${SEP}\n${message}\n${SEP}\nFund: ${safeId}`;
}

function formatTradeRetry(emoji, message, safeId) {
  // Messages look like: "BUY SYMBOL: error — retry 2/3"
  const retryMatch = message.match(/retry (\d+\/\d+)/);
  const retryLabel = retryMatch ? ` ${retryMatch[1]}` : '';
  const colonIdx = message.indexOf(': ');
  if (colonIdx !== -1) {
    const header = message.slice(0, colonIdx);
    const detail = message.slice(colonIdx + 2).replace(/\s*—\s*retry \d+\/\d+/, '');
    return `${emoji} RETRY${retryLabel}\n${SEP}\n${header}\n${detail}\n${SEP}\nFund: ${safeId}`;
  }
  return `${emoji} RETRY${retryLabel}\n${SEP}\n${message}\n${SEP}\nFund: ${safeId}`;
}

function formatPassthrough(emoji, type, message, safeId) {
  const label = TYPE_LABELS[type] || type.toUpperCase().replace(/_/g, ' ');
  return `${emoji} ${label}\n${SEP}\n${message}\n${SEP}\nFund: ${safeId}`;
}

function formatPortfolioDaily(emoji, message, safeId) {
  let data;
  try {
    data = JSON.parse(message);
  } catch {
    return formatPassthrough(emoji, 'portfolio_daily', message, safeId);
  }
  if (!data || !data.summary) {
    return formatPassthrough(emoji, 'portfolio_daily', message, safeId);
  }

  const s = data.summary;
  const alloc = data.allocation || {};
  const positions = data.positions || [];
  const alerts = data.allocationAlerts || [];

  const isPaper = process.env.PAPER_MODE === 'true';
  const dateStr = data.timestamp ? data.timestamp.slice(0, 10) : new Date().toISOString().slice(0, 10);

  const fmtUsd = (n) => {
    const abs = Math.abs(n);
    const [int, dec] = abs.toFixed(2).split('.');
    const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + '$' + withCommas + '.' + dec;
  };
  const fmtPct = (n) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
  const fmtPnlUsd = (n) => `${n > 0 ? '+' : ''}${fmtUsd(n)}`;
  const chainShort = (c) => (c === 'solana' ? 'sol' : c);
  const pnlArrow = (pnl) => (pnl > 0 ? '\u25B2' : pnl < 0 ? '\u25BC' : ' ');

  const sorted = [...positions].sort((a, b) => b.value - a.value);

  const lines = [];
  lines.push(`${emoji} PORTFOLIO REPORT`);
  lines.push(SEP);
  lines.push(isPaper ? `[PAPER] ${dateStr}` : dateStr);
  lines.push('');
  lines.push(`Total Value    ${fmtUsd(s.totalValue)}`);
  lines.push(`Deposited      ${fmtUsd(s.totalDeposited)}`);
  lines.push(`P&L            ${fmtPnlUsd(s.totalPnlUsd)} (${fmtPct(s.totalPnlPercent)})`);
  lines.push(`Cash           ${fmtUsd(s.cashBalance)}`);

  lines.push('');
  lines.push('ALLOCATION');
  for (const tier of ['base', 'conviction', 'moonshot', 'cash']) {
    if (alloc[tier] !== undefined) {
      const label = tier.charAt(0).toUpperCase() + tier.slice(1);
      lines.push(`  ${label.padEnd(13)}${alloc[tier].toFixed(1)}%`);
    }
  }

  if (alerts.length > 0) {
    lines.push('');
    lines.push('ALERTS');
    for (const alert of alerts) {
      lines.push(`  \u26A0 ${alert}`);
    }
  }

  lines.push('');
  if (sorted.length === 0) {
    lines.push('POSITIONS (0)');
    lines.push('  No open positions');
  } else {
    lines.push(`POSITIONS (${sorted.length})`);
    for (const p of sorted) {
      const arrow = pnlArrow(p.pnlPercent);
      const sym = p.symbol.padEnd(8);
      const tier = (p.tier || '').padEnd(11);
      const chain = chainShort(p.chain || '').padEnd(5);
      const val = fmtUsd(p.value).padStart(12);
      const pnl = fmtPct(p.pnlPercent).padStart(9);
      lines.push(`${arrow} ${sym} ${tier} ${chain} ${val} ${pnl}`);
    }
  }

  lines.push('');
  lines.push(SEP);
  lines.push(`Fund: ${safeId}`);
  return lines.join('\n');
}

const FORMATTERS = {
  trade_executed: (emoji, _type, _agent, message, safeId) => formatTradeExecuted(emoji, message, safeId),
  trade_failed: (emoji, _type, _agent, message, safeId) => formatTradeFailed(emoji, message, safeId),
  trade_retry: (emoji, _type, _agent, message, safeId) => formatTradeRetry(emoji, message, safeId),
  trade_proposal: (emoji, type, _agent, message, safeId) => formatPassthrough(emoji, type, message, safeId),
  sell_triggered: (emoji, type, _agent, message, safeId) => formatPassthrough(emoji, type, message, safeId),
  sentinel_alert_followup: (emoji, type, _agent, message, safeId) => formatPassthrough(emoji, type, message, safeId),
  model_failure: (emoji, type, _agent, message, safeId) => formatPassthrough(emoji, type, message, safeId),
  emergency_mode: (emoji, type, _agent, message, safeId) => formatPassthrough(emoji, type, message, safeId),
  recovered: (emoji, type, _agent, message, safeId) => formatPassthrough(emoji, type, message, safeId),
  rug_warning: (emoji, type, _agent, message, safeId) => formatPassthrough(emoji, type, message, safeId),
  signer_low_balance: (emoji, type, _agent, message, safeId) => formatPassthrough(emoji, type, message, safeId),
  system_health: (emoji, type, _agent, message, safeId) => formatPassthrough(emoji, type, message, safeId),
  heartbeat_summary: (emoji, type, _agent, message, safeId) => formatPassthrough(emoji, type, message, safeId),
  portfolio_daily: (emoji, _type, _agent, message, safeId) => formatPortfolioDaily(emoji, message, safeId),
  rebalance_event: (emoji, type, _agent, message, safeId) => formatPassthrough(emoji, type, message, safeId),
};

function formatMessage(type, agent, message, safeId) {
  const emoji = EMOJI_MAP[type] || '\u26A0\uFE0F';
  const formatter = FORMATTERS[type];
  if (formatter) {
    return formatter(emoji, type, agent, message || `${type} event`, safeId);
  }
  const label = type.toUpperCase().replace(/_/g, ' ');
  return `${emoji} ${label}\n${SEP}\n${message || `${type} event`}\n${SEP}\nFund: ${safeId}`;
}

async function main() {
  const type = getArg('type') || 'unknown';
  const agent = getArg('agent') || 'unknown';
  const message = getArg('message') || '';
  const safeId = process.env.SAFE_ID || 'unknown';
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!chatId) {
    console.log(
      JSON.stringify({
        status: 'skipped',
        reason: 'TELEGRAM_CHAT_ID not set',
        type,
        agent,
      }),
    );
    return;
  }

  const formattedMessage = formatMessage(type, agent, message, safeId);
  const threadId = resolveThreadId(type);

  try {
    const args = ['message', 'send', '--channel', 'telegram', '--target', chatId, '--message', formattedMessage];
    if (threadId) args.push('--thread-id', threadId);

    execFileSync('openclaw', args, {
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    log('info', 'send-alert', `sent type=${type} agent=${agent} topic=${threadId || 'default'}`);
    console.log(JSON.stringify({ status: 'sent', type, agent, topic: threadId || 'default' }));
  } catch (err) {
    log('warn', 'send-alert', `Failed to send via openclaw (type=${type}, agent=${agent}): ${err.message}`);
    console.error(`[send-alert] Failed to send via openclaw: ${err.message}`);
    console.log(JSON.stringify({ status: 'failed', type, agent, error: err.message }));
  }
}

main();
