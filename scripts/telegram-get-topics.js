#!/usr/bin/env node
/**
 * telegram-get-topics.js — Discover forum topic thread IDs in a Telegram supergroup
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=-100xxx node scripts/telegram-get-topics.js
 *
 * Output: Table of topic names and their thread IDs for use in env vars.
 *
 * The bot must be an admin in the supergroup with forum topics enabled.
 */

import 'dotenv/config';
import { log } from './log.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  log('error', 'telegram-get-topics', 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
  console.error('Error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
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
    throw new Error(`Telegram API error: ${data.description}`);
  }
  return data.result;
}

async function main() {
  // Verify chat is a supergroup with topics
  const chat = await callApi('getChat', { chat_id: CHAT_ID });

  if (!chat.is_forum) {
    log('error', 'telegram-get-topics', `Chat "${chat.title}" is not a forum (topics not enabled)`);
    console.error(`Error: Chat "${chat.title}" is not a forum (topics not enabled)`);
    console.error('Enable topics: Group Settings → Topics → Toggle on');
    process.exit(1);
  }

  console.log(`\nSupergroup: ${chat.title}`);
  console.log(`Chat ID: ${CHAT_ID}`);
  console.log(`\nTo get topic thread IDs:`);
  console.log(`1. Send a message in each topic`);
  console.log(`2. Forward it to @userinfobot or check via getUpdates\n`);

  // Try to get recent updates to find topic thread IDs
  console.log('Checking recent messages for topic thread IDs...\n');

  try {
    const updates = await callApi('getUpdates', {
      offset: -100,
      limit: 100,
      allowed_updates: ['message'],
    });

    const topics = new Map();
    for (const update of updates) {
      const msg = update.message;
      if (!msg || String(msg.chat.id) !== String(CHAT_ID)) continue;
      if (msg.message_thread_id && msg.forum_topic_created) {
        topics.set(msg.message_thread_id, msg.forum_topic_created.name);
      } else if (msg.message_thread_id && !topics.has(msg.message_thread_id)) {
        topics.set(
          msg.message_thread_id,
          msg.reply_to_message?.forum_topic_created?.name || `Topic ${msg.message_thread_id}`,
        );
      }
    }

    if (topics.size === 0) {
      console.log('No topics found in recent updates.');
      console.log('Send a message in each topic, then run this script again.\n');
      console.log('Alternatively, set thread IDs manually:');
      console.log('  TG_TOPIC_RESEARCH=<id>');
      console.log('  TG_TOPIC_SENTINEL=<id>');
      console.log('  TG_TOPIC_EXECUTOR=<id>');
      console.log('  TG_TOPIC_ALERTS=<id>');
      console.log('  TG_TOPIC_SYSTEM=<id>');
      console.log('  TG_TOPIC_PORTFOLIO=<id>');
    } else {
      console.log('Found topics:');
      console.log('─'.repeat(50));
      for (const [threadId, name] of topics) {
        console.log(`  ${name.padEnd(20)} → thread_id: ${threadId}`);
      }
      console.log('─'.repeat(50));
      console.log('\nAdd to .env or docker-compose.yml:');
      for (const [threadId, name] of topics) {
        const envName = `TG_TOPIC_${name.toUpperCase().replace(/[^A-Z]/g, '_')}`;
        console.log(`  ${envName}=${threadId}`);
      }
    }
  } catch (err) {
    // getUpdates may fail if webhook is set — that's ok
    if (err.message.includes('conflict')) {
      console.log('Cannot use getUpdates — a webhook is active.');
      console.log('Use @RawDataBot or forward messages to find thread IDs.\n');
    } else {
      console.log(`Note: ${err.message}\n`);
    }
    console.log('Set thread IDs manually in your .env:');
    console.log('  TG_TOPIC_RESEARCH=<id>');
    console.log('  TG_TOPIC_SENTINEL=<id>');
    console.log('  TG_TOPIC_EXECUTOR=<id>');
    console.log('  TG_TOPIC_ALERTS=<id>');
    console.log('  TG_TOPIC_SYSTEM=<id>');
    console.log('  TG_TOPIC_PORTFOLIO=<id>');
  }

  console.log(JSON.stringify({ status: 'ok', chat_id: CHAT_ID, title: chat.title, is_forum: chat.is_forum }));
}

main().catch((err) => {
  log('error', 'telegram-get-topics', `Failed: ${err.message}`);
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
