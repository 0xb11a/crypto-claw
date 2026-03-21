#!/usr/bin/env node
/**
 * send-alert.js — Send alerts via Telegram Bot API
 *
 * Usage:
 *   node scripts/send-alert.js --type <type> --agent <agent> --message "<text>"
 *
 * Types: model_failure, emergency_mode, recovered
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN  — Bot token from @BotFather
 *   TELEGRAM_CHAT_ID    — Chat/group ID for alerts
 *   SAFE_ID             — Fund identifier (included in alert)
 *
 * Exits 0 even on failure (alerting should never block the main loop).
 * Output: JSON to stdout with { status, type, agent }
 */

import 'dotenv/config';

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

function escapeMarkdownV2(text) {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

async function sendTelegram(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
  return res.json();
}

async function main() {
  const type = getArg('type') || 'unknown';
  const agent = getArg('agent') || 'unknown';
  const message = getArg('message') || '';
  const safeId = process.env.SAFE_ID || 'unknown';
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log(
      JSON.stringify({
        status: 'skipped',
        reason: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set',
        type,
        agent,
      }),
    );
    return;
  }

  const emoji = type === 'recovered' ? '\u2705' : '\u26A0\uFE0F';
  const escapedSafeId = escapeMarkdownV2(safeId);
  const escapedAgent = escapeMarkdownV2(agent);
  const escapedType = escapeMarkdownV2(type);
  const escapedMessage = escapeMarkdownV2(message || `${type} event for ${agent}`);

  const text = `${emoji} *CryptoClaw Alert*
Fund: \`${escapedSafeId}\`
Agent: ${escapedAgent}
Type: ${escapedType}
${escapedMessage}`;

  try {
    await sendTelegram(token, chatId, text);
    console.log(JSON.stringify({ status: 'sent', type, agent }));
  } catch (err) {
    console.error(`[send-alert] Failed to send: ${err.message}`);
    console.log(JSON.stringify({ status: 'failed', type, agent, error: err.message }));
  }
}

main();
