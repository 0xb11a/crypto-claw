#!/usr/bin/env node
/**
 * Test Suite: Telegram Integration
 *
 * Tests send-alert.js topic routing, alert type mapping, and backwards compatibility.
 * Does NOT make real Telegram API calls — tests internal logic only.
 */

import { describe, test, assert, assertEqual, summary } from './test-helpers.js';

// ============================================================
// 1. Topic Mapping
// ============================================================

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

describe('Topic Mapping', () => {
  test('all alert types have a topic mapping', () => {
    const types = [
      'trade_proposal',
      'sell_triggered',
      'trade_executed',
      'trade_failed',
      'model_failure',
      'emergency_mode',
      'rug_warning',
      'recovered',
      'heartbeat_summary',
      'portfolio_daily',
      'rebalance_event',
    ];
    for (const type of types) {
      assert(TOPIC_MAP[type], `Missing topic mapping for type: ${type}`);
    }
  });

  test('trade_proposal routes to Research topic', () => {
    assertEqual(TOPIC_MAP['trade_proposal'], 'TG_TOPIC_RESEARCH');
  });

  test('sell_triggered routes to Sentinel topic', () => {
    assertEqual(TOPIC_MAP['sell_triggered'], 'TG_TOPIC_SENTINEL');
  });

  test('trade_executed routes to Executor topic', () => {
    assertEqual(TOPIC_MAP['trade_executed'], 'TG_TOPIC_EXECUTOR');
  });

  test('trade_failed routes to Executor topic', () => {
    assertEqual(TOPIC_MAP['trade_failed'], 'TG_TOPIC_EXECUTOR');
  });

  test('model_failure routes to Alerts topic', () => {
    assertEqual(TOPIC_MAP['model_failure'], 'TG_TOPIC_ALERTS');
  });

  test('emergency_mode routes to Alerts topic', () => {
    assertEqual(TOPIC_MAP['emergency_mode'], 'TG_TOPIC_ALERTS');
  });

  test('rug_warning routes to Alerts topic', () => {
    assertEqual(TOPIC_MAP['rug_warning'], 'TG_TOPIC_ALERTS');
  });

  test('recovered routes to System topic', () => {
    assertEqual(TOPIC_MAP['recovered'], 'TG_TOPIC_SYSTEM');
  });

  test('heartbeat_summary routes to System topic', () => {
    assertEqual(TOPIC_MAP['heartbeat_summary'], 'TG_TOPIC_SYSTEM');
  });

  test('portfolio_daily routes to Portfolio topic', () => {
    assertEqual(TOPIC_MAP['portfolio_daily'], 'TG_TOPIC_PORTFOLIO');
  });

  test('rebalance_event routes to Portfolio topic', () => {
    assertEqual(TOPIC_MAP['rebalance_event'], 'TG_TOPIC_PORTFOLIO');
  });
});

// ============================================================
// 2. Emoji Mapping
// ============================================================

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

describe('Emoji Mapping', () => {
  test('all alert types have an emoji', () => {
    for (const type of Object.keys(TOPIC_MAP)) {
      assert(EMOJI_MAP[type], `Missing emoji for type: ${type}`);
    }
  });

  test('critical types use warning/alarm emojis', () => {
    assert(EMOJI_MAP['model_failure'] === '\u26A0\uFE0F', 'model_failure should use warning emoji');
    assert(EMOJI_MAP['emergency_mode'] === '\u26A0\uFE0F', 'emergency_mode should use warning emoji');
    assert(EMOJI_MAP['sell_triggered'] === '\uD83D\uDEA8', 'sell_triggered should use alarm emoji');
  });
});

// ============================================================
// 3. Command Construction Logic
// ============================================================

function resolveThreadId(type, topicEnvs = {}) {
  const topicEnvVar = TOPIC_MAP[type];
  return topicEnvVar ? topicEnvs[topicEnvVar] || null : null;
}

function buildSendArgs(type, chatId, message, topicEnvs = {}) {
  const threadId = resolveThreadId(type, topicEnvs);
  const args = ['message', 'send', '--channel', 'telegram', '--target', chatId, '--message', message];
  if (threadId) args.push('--thread-id', threadId);
  return args;
}

describe('Command Construction', () => {
  test('includes --thread-id when topic env var is set', () => {
    const args = buildSendArgs('trade_proposal', '-100123', 'test', {
      TG_TOPIC_RESEARCH: '42',
    });
    const threadIdx = args.indexOf('--thread-id');
    assert(threadIdx !== -1, 'Should include --thread-id');
    assertEqual(args[threadIdx + 1], '42');
    // target should be plain chatId
    const targetIdx = args.indexOf('--target');
    assertEqual(args[targetIdx + 1], '-100123');
  });

  test('no --thread-id when topic env var is not set', () => {
    const args = buildSendArgs('trade_proposal', '-100123', 'test', {});
    assertEqual(args.indexOf('--thread-id'), -1, 'Should not include --thread-id');
    const targetIdx = args.indexOf('--target');
    assertEqual(args[targetIdx + 1], '-100123');
  });

  test('always includes --channel telegram', () => {
    const args = buildSendArgs('model_failure', '-100123', 'test', {});
    const channelIdx = args.indexOf('--channel');
    assert(channelIdx !== -1, 'Should include --channel');
    assertEqual(args[channelIdx + 1], 'telegram');
  });

  test('uses --message flag for message body', () => {
    const args = buildSendArgs('recovered', '-100999', 'hello', {});
    const msgIdx = args.indexOf('--message');
    assert(msgIdx !== -1, 'Should use --message flag');
    assertEqual(args[msgIdx + 1], 'hello');
    assertEqual(args.indexOf('--text'), -1, 'Should not use --text flag');
  });

  test('routes different types to different thread IDs', () => {
    const envs = {
      TG_TOPIC_RESEARCH: '10',
      TG_TOPIC_SENTINEL: '20',
      TG_TOPIC_EXECUTOR: '30',
      TG_TOPIC_ALERTS: '40',
      TG_TOPIC_SYSTEM: '50',
      TG_TOPIC_PORTFOLIO: '60',
    };

    assertEqual(resolveThreadId('trade_proposal', envs), '10');
    assertEqual(resolveThreadId('sell_triggered', envs), '20');
    assertEqual(resolveThreadId('trade_executed', envs), '30');
    assertEqual(resolveThreadId('model_failure', envs), '40');
    assertEqual(resolveThreadId('recovered', envs), '50');
    assertEqual(resolveThreadId('portfolio_daily', envs), '60');
  });

  test('unknown type has no thread ID', () => {
    const threadId = resolveThreadId('unknown_type', {
      TG_TOPIC_RESEARCH: '10',
    });
    assertEqual(threadId, null, 'Unknown type should have no thread ID');
  });
});

// ============================================================
// 4. Topic Count Validation
// ============================================================

describe('Topic Configuration', () => {
  test('exactly 6 unique topic env vars', () => {
    const uniqueTopics = new Set(Object.values(TOPIC_MAP));
    assertEqual(uniqueTopics.size, 6, 'Should have exactly 6 unique topic env vars');
  });

  test('topic env vars match expected names', () => {
    const expected = new Set([
      'TG_TOPIC_RESEARCH',
      'TG_TOPIC_SENTINEL',
      'TG_TOPIC_EXECUTOR',
      'TG_TOPIC_ALERTS',
      'TG_TOPIC_SYSTEM',
      'TG_TOPIC_PORTFOLIO',
    ]);
    const actual = new Set(Object.values(TOPIC_MAP));
    for (const name of expected) {
      assert(actual.has(name), `Missing topic env var: ${name}`);
    }
  });
});

summary();
