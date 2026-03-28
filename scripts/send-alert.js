#!/usr/bin/env node
/**
 * send-alert.js — Send alerts via OpenClaw message send (Telegram)
 *
 * Usage:
 *   node scripts/send-alert.js --type <type> --agent <agent> --message "<text>"
 *
 * Types:
 *   model_failure, emergency_mode, recovered, trade_proposal, trade_executed,
 *   trade_failed, sell_triggered, rug_warning, heartbeat_summary,
 *   portfolio_daily, rebalance_event
 *
 * Env vars:
 *   TELEGRAM_CHAT_ID      — Supergroup/chat ID for alerts
 *   SAFE_ID               — Fund identifier (included in alert)
 *   TG_TOPIC_RESEARCH     — Forum topic thread ID for Research
 *   TG_TOPIC_SENTINEL     — Forum topic thread ID for Sentinel
 *   TG_TOPIC_EXECUTOR     — Forum topic thread ID for Executor
 *   TG_TOPIC_ALERTS       — Forum topic thread ID for Alerts (urgent)
 *   TG_TOPIC_SYSTEM       — Forum topic thread ID for System
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
import { execFileSync } from 'node:child_process';

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

// Alert type → topic env var mapping
const TOPIC_MAP = {
  trade_proposal: 'TG_TOPIC_RESEARCH',
  sell_triggered: 'TG_TOPIC_SENTINEL',
  trade_executed: 'TG_TOPIC_EXECUTOR',
  trade_failed: 'TG_TOPIC_EXECUTOR',
  model_failure: 'TG_TOPIC_ALERTS',
  emergency_mode: 'TG_TOPIC_ALERTS',
  rug_warning: 'TG_TOPIC_ALERTS',
  recovered: 'TG_TOPIC_SYSTEM',
  heartbeat_summary: 'TG_TOPIC_SYSTEM',
  portfolio_daily: 'TG_TOPIC_PORTFOLIO',
  rebalance_event: 'TG_TOPIC_PORTFOLIO',
};

const EMOJI_MAP = {
  recovered: '\u2705',
  trade_proposal: '\uD83D\uDCCA',
  trade_executed: '\u2705',
  trade_failed: '\u274C',
  sell_triggered: '\uD83D\uDEA8',
  model_failure: '\u26A0\uFE0F',
  emergency_mode: '\u26A0\uFE0F',
  rug_warning: '\uD83D\uDEA8',
  heartbeat_summary: '\uD83D\uDCE1',
  portfolio_daily: '\uD83D\uDCB0',
  rebalance_event: '\u2696\uFE0F',
};

function resolveThreadId(type) {
  const envVar = TOPIC_MAP[type];
  return envVar ? process.env[envVar] || null : null;
}

function formatMessage(type, agent, message, safeId) {
  const emoji = EMOJI_MAP[type] || '\u26A0\uFE0F';
  return `${emoji} CryptoClaw Alert\nFund: ${safeId}\nAgent: ${agent}\nType: ${type}\n${message || `${type} event for ${agent}`}`;
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

  // Build target: "chatId:topic:threadId" if topic is set, otherwise plain chatId
  const target = threadId ? `${chatId}:topic:${threadId}` : chatId;

  try {
    const args = ['message', 'send', '--channel', 'telegram', '--target', target, '--text', formattedMessage];

    execFileSync('openclaw', args, {
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    console.log(JSON.stringify({ status: 'sent', type, agent, topic: threadId || 'default' }));
  } catch (err) {
    console.error(`[send-alert] Failed to send via openclaw: ${err.message}`);
    console.log(JSON.stringify({ status: 'failed', type, agent, error: err.message }));
  }
}

main();
