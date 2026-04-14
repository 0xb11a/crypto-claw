#!/usr/bin/env node
/**
 * send-approval.js — Send Telegram message with inline Approve/Reject buttons
 *
 * Uses a dedicated approval bot (separate from the main OpenClaw bot) to send
 * trade proposals with inline keyboard buttons. Button presses are handled by
 * approval-bot.js (background polling process).
 *
 * Usage:
 *   node scripts/send-approval.js --order-id <id>
 *
 * Env vars:
 *   TELEGRAM_APPROVAL_BOT_TOKEN — Bot token for the approval bot (@BotFather)
 *   TELEGRAM_CHAT_ID            — Supergroup/chat ID
 *   TG_TOPIC_RESEARCH           — Forum topic thread ID for Research (optional)
 *   SAFE_ID                     — Fund identifier (included in message)
 *
 * Exits 0 even on failure (alerting should never block the main loop).
 * Output: JSON to stdout with { status, order_id, message_id }
 */

import 'dotenv/config';
import { getDb, close } from './db.js';
import { log } from './log.js';

const BOT_TOKEN = process.env.TELEGRAM_APPROVAL_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const THREAD_ID = process.env.TG_TOPIC_RESEARCH || null;
const SAFE_ID = process.env.SAFE_ID || 'unknown';

const SEP = '\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015';

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

async function callApi(method, params = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
  return data.result;
}

function formatOrderMessage(order) {
  const lines = [];
  lines.push(`\uD83D\uDCCA TRADE PROPOSAL`);
  lines.push(SEP);
  lines.push(`BUY $${order.symbol} on ${order.chain}`);

  const pct = order.percent_of_portfolio
    ? ` (${order.percent_of_portfolio}% ${order.tier})`
    : order.tier
      ? ` (${order.tier})`
      : '';
  const score = order.analysis_score != null ? ` \u2014 score: ${order.analysis_score}/100` : '';
  lines.push(`$${order.amount}${pct}${score}`);

  lines.push('');
  if (order.entry_price != null) lines.push(`Entry: $${order.entry_price}`);
  if (order.stop_loss != null) lines.push(`Stop Loss: ${order.stop_loss}%`);

  if (order.take_profit_levels) {
    try {
      const tps =
        typeof order.take_profit_levels === 'string' ? JSON.parse(order.take_profit_levels) : order.take_profit_levels;
      if (Array.isArray(tps) && tps.length > 0) {
        const tpStr = tps
          .map((tp) => `${tp.price || tp.target || tp.level}x (sell ${tp.sellPercent || tp.sell_percent}%)`)
          .join(', ');
        lines.push(`Take Profit: ${tpStr}`);
      }
    } catch {}
  }

  if (order.risk_score != null) lines.push(`Risk: ${order.risk_score}/100`);

  if (order.reasoning) {
    lines.push('');
    const reason = order.reasoning.length > 200 ? order.reasoning.slice(0, 200) + '...' : order.reasoning;
    lines.push(reason);
  }

  lines.push(SEP);
  lines.push(`Fund: ${SAFE_ID}`);
  return lines.join('\n');
}

async function main() {
  const orderId = getArg('order-id');

  if (!BOT_TOKEN) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'TELEGRAM_APPROVAL_BOT_TOKEN not set' }));
    return;
  }

  if (!CHAT_ID) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'TELEGRAM_CHAT_ID not set' }));
    return;
  }

  if (!orderId) {
    log('error', 'send-approval', 'Missing --order-id argument');
    console.log(JSON.stringify({ status: 'failed', error: 'Missing --order-id' }));
    process.exit(1);
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    log('error', 'send-approval', `DB error: ${err.message}`);
    console.log(JSON.stringify({ status: 'failed', error: `DB error: ${err.message}` }));
    return;
  }

  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      log('warn', 'send-approval', `Order not found: ${orderId}`);
      console.log(JSON.stringify({ status: 'failed', error: `Order not found: ${orderId}` }));
      return;
    }

    if (order.status !== 'pending') {
      console.log(JSON.stringify({ status: 'skipped', reason: `Order is ${order.status}, not pending` }));
      return;
    }

    const text = formatOrderMessage(order);
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '\u2705 Approve', callback_data: `approve:${orderId}` },
          { text: '\u274C Reject', callback_data: `reject:${orderId}` },
        ],
      ],
    };

    const params = {
      chat_id: CHAT_ID,
      text,
      reply_markup: replyMarkup,
    };
    if (THREAD_ID) params.message_thread_id = Number(THREAD_ID);

    const result = await callApi('sendMessage', params);
    const messageId = result.message_id;

    // Store message ID for later editing (when button is pressed)
    db.prepare('UPDATE orders SET tg_message_id = ? WHERE id = ?').run(messageId, orderId);

    console.log(JSON.stringify({ status: 'sent', order_id: orderId, message_id: messageId }));
  } catch (err) {
    log('warn', 'send-approval', `Failed to send approval message (order=${orderId}): ${err.message}`);
    console.log(JSON.stringify({ status: 'failed', order_id: orderId, error: err.message }));
  } finally {
    close();
  }
}

main();
