#!/usr/bin/env node
/**
 * approval-bot.js — Background Telegram bot for inline Approve/Reject buttons
 *
 * Long-polls Telegram getUpdates for callback_query events (button presses)
 * from the dedicated approval bot. Handles approve/reject actions on pending
 * buy orders, then edits the original message to reflect the result.
 *
 * Started as a background process in entrypoint.sh. Runs indefinitely.
 * Uses a separate bot token (TELEGRAM_APPROVAL_BOT_TOKEN) to avoid conflicts
 * with OpenClaw's main bot polling.
 *
 * Env vars:
 *   TELEGRAM_APPROVAL_BOT_TOKEN — Bot token for the approval bot
 *   TELEGRAM_OWNER_ID           — Only this user can approve/reject
 *   TELEGRAM_CHAT_ID            — Supergroup/chat ID (for editing messages)
 *   SAFE_ID                     — Fund identifier
 */

import 'dotenv/config';
import { getDb, close } from './db.js';
import { log } from './log.js';
import { execFileSync } from 'node:child_process';

const BOT_TOKEN = process.env.TELEGRAM_APPROVAL_BOT_TOKEN;
const OWNER_ID = process.env.TELEGRAM_OWNER_ID ? Number(process.env.TELEGRAM_OWNER_ID) : null;
const SAFE_ID = process.env.SAFE_ID || 'unknown';

const SEP = '\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015';
const POLL_TIMEOUT = 30; // seconds — Telegram long-polling timeout
const ERROR_BACKOFF = 5000; // ms — pause after errors

if (!BOT_TOKEN) {
  log('info', 'approval-bot', 'TELEGRAM_APPROVAL_BOT_TOKEN not set — exiting');
  process.exit(0);
}

if (!OWNER_ID) {
  log('warn', 'approval-bot', 'TELEGRAM_OWNER_ID not set — approval bot requires owner verification');
  process.exit(1);
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
    throw new Error(`Telegram API ${method}: ${data.description}`);
  }
  return data.result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function approveOrder(db, orderId) {
  const row = db.prepare('SELECT status, action, symbol, chain FROM orders WHERE id = ?').get(orderId);
  if (!row) return { ok: false, reason: 'Order not found' };
  if (row.status !== 'pending') return { ok: false, reason: `Order already ${row.status}` };

  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE orders SET status = 'approved', approved_at = ?, approved_by = 'human', status_changed_at = ?, status_changed_by = 'human' WHERE id = ? AND status = 'pending'",
    )
    .run(now, now, orderId);

  if (result.changes === 0) return { ok: false, reason: 'Order already processed' };
  return { ok: true, symbol: row.symbol, chain: row.chain };
}

function rejectOrder(db, orderId) {
  const row = db.prepare('SELECT status, action, symbol, chain FROM orders WHERE id = ?').get(orderId);
  if (!row) return { ok: false, reason: 'Order not found' };
  if (row.status !== 'pending') return { ok: false, reason: `Order already ${row.status}` };

  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE orders SET status = 'rejected', status_reason = 'rejected via Telegram button', status_changed_at = ?, status_changed_by = 'human' WHERE id = ? AND status = 'pending'",
    )
    .run(now, orderId);

  if (result.changes === 0) return { ok: false, reason: 'Order already processed' };
  return { ok: true, symbol: row.symbol, chain: row.chain };
}

function buildEditedText(originalText, action, timestamp) {
  const statusLabel = action === 'approve' ? 'APPROVED \u2705' : 'REJECTED \u274C';
  const byLine = action === 'approve' ? `Approved by human at ${timestamp}` : `Rejected by human at ${timestamp}`;

  // Replace the header line
  const edited = originalText.replace(
    /\uD83D\uDCCA TRADE PROPOSAL/,
    `\uD83D\uDCCA TRADE PROPOSAL \u2014 ${statusLabel}`,
  );

  // Append status line before "Fund:" footer
  return edited.replace(new RegExp(`(${SEP}\nFund: .*)$`), `${SEP}\n${byLine}\nFund: ${SAFE_ID}`);
}

async function handleCallback(db, query) {
  const callbackId = query.id;
  const userId = query.from?.id;
  const data = query.data;
  const message = query.message;

  // Security: only the fund owner can approve/reject
  if (userId !== OWNER_ID) {
    await callApi('answerCallbackQuery', { callback_query_id: callbackId, text: 'Unauthorized', show_alert: true });
    log('warn', 'approval-bot', `Unauthorized callback from user ${userId}`);
    return;
  }

  // Parse callback_data: "approve:order-id" or "reject:order-id"
  if (!data || !data.includes(':')) {
    await callApi('answerCallbackQuery', { callback_query_id: callbackId, text: 'Invalid action' });
    return;
  }

  const [action, orderId] = [data.slice(0, data.indexOf(':')), data.slice(data.indexOf(':') + 1)];

  if (action !== 'approve' && action !== 'reject') {
    await callApi('answerCallbackQuery', { callback_query_id: callbackId, text: 'Invalid action' });
    return;
  }

  // Execute the action
  const result = action === 'approve' ? approveOrder(db, orderId) : rejectOrder(db, orderId);

  if (!result.ok) {
    await callApi('answerCallbackQuery', { callback_query_id: callbackId, text: result.reason, show_alert: true });
    log('info', 'approval-bot', `${action} ${orderId}: ${result.reason}`);
    return;
  }

  // Answer the callback (user sees toast in Telegram)
  const toastText =
    action === 'approve' ? `Approved $${result.symbol} — executor will process shortly` : `Rejected $${result.symbol}`;
  await callApi('answerCallbackQuery', { callback_query_id: callbackId, text: toastText });

  // Edit the original message to show result and remove buttons
  if (message) {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const editedText = buildEditedText(message.text || '', action, timestamp);
    try {
      await callApi('editMessageText', {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text: editedText,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      log('warn', 'approval-bot', `Failed to edit message: ${err.message}`);
    }
  }

  const actionVerb = action === 'approve' ? 'Approved' : 'Rejected';
  log('info', 'approval-bot', `${actionVerb} order ${orderId} ($${result.symbol} on ${result.chain})`);

  // Send confirmation alert via the main bot (OpenClaw channel)
  try {
    const alertType = action === 'approve' ? 'system_health' : 'system_health';
    const alertMsg = `${actionVerb} via Telegram: $${result.symbol} on ${result.chain} [${orderId}]`;
    execFileSync(
      'node',
      ['scripts/send-alert.js', '--type', alertType, '--agent', 'approval-bot', '--message', alertMsg],
      { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    // Alert is best-effort
  }
}

async function pollLoop() {
  const db = getDb();
  let offset = 0;

  log('info', 'approval-bot', 'Started — polling for callback queries');

  while (true) {
    try {
      const updates = await callApi('getUpdates', {
        offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: ['callback_query'],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.callback_query) {
          try {
            await handleCallback(db, update.callback_query);
          } catch (err) {
            log('error', 'approval-bot', `Callback handling error: ${err.message}`);
            // Try to acknowledge the callback to prevent repeated delivery
            try {
              await callApi('answerCallbackQuery', {
                callback_query_id: update.callback_query.id,
                text: 'Error processing request',
              });
            } catch {}
          }
        }
      }
    } catch (err) {
      log('warn', 'approval-bot', `Polling error: ${err.message}`);
      await sleep(ERROR_BACKOFF);
    }
  }
}

pollLoop().catch((err) => {
  log('error', 'approval-bot', `Fatal error: ${err.message}`);
  close();
  process.exit(1);
});
