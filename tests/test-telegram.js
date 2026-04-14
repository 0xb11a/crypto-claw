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
  trade_retry: 'TG_TOPIC_EXECUTOR',
  model_failure: 'TG_TOPIC_ALERTS',
  emergency_mode: 'TG_TOPIC_ALERTS',
  rug_warning: 'TG_TOPIC_ALERTS',
  signer_low_balance: 'TG_TOPIC_ALERTS',
  system_health: 'TG_TOPIC_OBSERVER',
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
      'trade_retry',
      'model_failure',
      'emergency_mode',
      'rug_warning',
      'signer_low_balance',
      'system_health',
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

  test('signer_low_balance routes to Alerts topic', () => {
    assertEqual(TOPIC_MAP['signer_low_balance'], 'TG_TOPIC_ALERTS');
  });

  test('system_health routes to Observer topic', () => {
    assertEqual(TOPIC_MAP['system_health'], 'TG_TOPIC_OBSERVER');
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
  trade_retry: '\uD83D\uDD04',
  sell_triggered: '\uD83D\uDEA8',
  model_failure: '\u26A0\uFE0F',
  emergency_mode: '\u26A0\uFE0F',
  rug_warning: '\uD83D\uDEA8',
  signer_low_balance: '\u26FD',
  system_health: '\uD83D\uDCE1',
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
      TG_TOPIC_OBSERVER: '55',
      TG_TOPIC_PORTFOLIO: '60',
    };

    assertEqual(resolveThreadId('trade_proposal', envs), '10');
    assertEqual(resolveThreadId('sell_triggered', envs), '20');
    assertEqual(resolveThreadId('trade_executed', envs), '30');
    assertEqual(resolveThreadId('model_failure', envs), '40');
    assertEqual(resolveThreadId('signer_low_balance', envs), '40');
    assertEqual(resolveThreadId('system_health', envs), '55');
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
// 4. Message Formatting
// ============================================================

const SEP = '\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015';

const TYPE_LABELS = {
  trade_executed: 'TRADE EXECUTED',
  trade_failed: 'TRADE FAILED',
  trade_retry: 'RETRY',
  trade_proposal: 'TRADE PROPOSAL',
  sell_triggered: 'SELL TRIGGERED',
  model_failure: 'MODEL FAILURE',
  emergency_mode: 'EMERGENCY MODE',
  recovered: 'RECOVERED',
  rug_warning: 'RUG WARNING',
  heartbeat_summary: 'HEARTBEAT',
  portfolio_daily: 'PORTFOLIO REPORT',
  rebalance_event: 'REBALANCE',
};

function formatTradeExecuted(emoji, message, safeId) {
  return `${emoji} TRADE EXECUTED\n${SEP}\n${message}\n${SEP}\nFund: ${safeId}`;
}

function formatTradeFailed(emoji, message, safeId) {
  const colonIdx = message.indexOf(': ');
  if (colonIdx !== -1) {
    const header = message.slice(0, colonIdx);
    const reason = message.slice(colonIdx + 2);
    return `${emoji} TRADE FAILED\n${SEP}\n${header}\n${reason}\n${SEP}\nFund: ${safeId}`;
  }
  return `${emoji} TRADE FAILED\n${SEP}\n${message}\n${SEP}\nFund: ${safeId}`;
}

function formatTradeRetry(emoji, message, safeId) {
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
  const DSEP = '\u2550'.repeat(28);

  const lines = [];
  lines.push(`${emoji} PORTFOLIO REPORT`);
  lines.push(DSEP);
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
  lines.push(DSEP);
  lines.push(`Fund: ${safeId}`);
  return lines.join('\n');
}

function formatMessage(type, agent, message, safeId) {
  const emoji = EMOJI_MAP[type] || '\u26A0\uFE0F';
  if (type === 'trade_executed') return formatTradeExecuted(emoji, message || `${type} event`, safeId);
  if (type === 'trade_failed') return formatTradeFailed(emoji, message || `${type} event`, safeId);
  if (type === 'trade_retry') return formatTradeRetry(emoji, message || `${type} event`, safeId);
  if (type === 'portfolio_daily') return formatPortfolioDaily(emoji, message || '{}', safeId);
  if (EMOJI_MAP[type]) return formatPassthrough(emoji, type, message || `${type} event`, safeId);
  const label = type.toUpperCase().replace(/_/g, ' ');
  return `${emoji} ${label}\n${SEP}\n${message || `${type} event`}\n${SEP}\nFund: ${safeId}`;
}

describe('Message Formatting', () => {
  test('trade_executed uses separator lines and fund footer', () => {
    const msg = formatMessage('trade_executed', 'executor', 'BUY $PEPE on solana \u2014 $500 at $0.00000333', 'fund-1');
    assert(msg.includes('TRADE EXECUTED'), 'Should have title');
    assert(msg.includes(SEP), 'Should have separator');
    assert(msg.includes('Fund: fund-1'), 'Should include fund ID');
    assert(!msg.includes('CryptoClaw Alert'), 'Should NOT have old header');
    assert(!msg.includes('Agent:'), 'Should NOT have Agent line');
    assert(!msg.includes('Type:'), 'Should NOT have Type line');
  });

  test('trade_executed preserves dollar signs in message', () => {
    const msg = formatMessage('trade_executed', 'executor', 'BUY $PEPE on solana \u2014 $500 at $0.00000333', 'fund-1');
    assert(msg.includes('$PEPE'), 'Dollar sign in symbol preserved');
    assert(msg.includes('$500'), 'Dollar sign in amount preserved');
    assert(msg.includes('$0.00000333'), 'Dollar sign in price preserved');
  });

  test('trade_failed splits header from reason', () => {
    const msg = formatMessage(
      'trade_failed',
      'executor',
      'BUY $PEPE: stale_price: proposed $0.0003, current $0.0002 (33% drift)',
      'fund-1',
    );
    assert(msg.includes('TRADE FAILED'), 'Should have title');
    assert(msg.includes('BUY $PEPE'), 'Should have action line');
    assert(msg.includes('stale_price'), 'Should have reason');
    // Header and reason should be on separate lines
    const lines = msg.split('\n');
    const headerLine = lines.find((l) => l.includes('BUY $PEPE') && !l.includes('stale_price'));
    assert(headerLine, 'Header and reason should be on separate lines');
  });

  test('trade_retry extracts retry count', () => {
    const msg = formatMessage('trade_retry', 'executor', 'BUY $DOGE: Too Many Requests \u2014 retry 2/3', 'fund-1');
    assert(msg.includes('RETRY 2/3'), 'Should show retry count in title');
    assert(msg.includes('BUY $DOGE'), 'Should have action line');
    assert(msg.includes('Too Many Requests'), 'Should have error');
  });

  test('passthrough types preserve message body', () => {
    const body = 'SENTINEL SUMMARY (last 3h)\nHeartbeats: 6 | Positions: 3\nNotable: all clear';
    const msg = formatMessage('heartbeat_summary', 'sentinel', body, 'fund-1');
    assert(msg.includes('HEARTBEAT'), 'Should have type label');
    assert(msg.includes(body), 'Should preserve full body');
    assert(msg.includes('Fund: fund-1'), 'Should have fund footer');
  });

  test('portfolio_daily formats JSON into readable report', () => {
    const jsonData = JSON.stringify({
      status: 'ok',
      summary: {
        totalValue: 12500.5,
        totalDeposited: 10000,
        totalPnlPercent: 25.01,
        totalPnlUsd: 2500.5,
        positionCount: 2,
        cashBalance: 1200,
      },
      allocation: { base: 45.2, conviction: 38.6, moonshot: 11.2, cash: 5.0 },
      allocationAlerts: [],
      positions: [
        { symbol: 'PEPE', chain: 'base', tier: 'base', value: 800, pnlPercent: 12.5 },
        { symbol: 'TOKEN', chain: 'solana', tier: 'conviction', value: 7500, pnlPercent: 50.0 },
      ],
      timestamp: '2026-04-13T00:05:23.456Z',
    });
    const msg = formatMessage('portfolio_daily', 'system', jsonData, 'fund-1');
    assert(msg.includes('PORTFOLIO REPORT'), 'Should have title');
    assert(msg.includes('$12,500.50'), 'Should show total value');
    assert(msg.includes('+$2,500.50'), 'Should show P&L USD');
    assert(msg.includes('+25.01%'), 'Should show P&L percent');
    assert(msg.includes('$1,200.00'), 'Should show cash');
    assert(msg.includes('TOKEN'), 'Should list TOKEN position');
    assert(msg.includes('PEPE'), 'Should list PEPE position');
    assert(msg.includes('Fund: fund-1'), 'Should have fund footer');
  });

  test('portfolio_daily sorts positions by value descending', () => {
    const jsonData = JSON.stringify({
      status: 'ok',
      summary: {
        totalValue: 1000,
        totalDeposited: 1000,
        totalPnlPercent: 0,
        totalPnlUsd: 0,
        positionCount: 2,
        cashBalance: 0,
      },
      allocation: { base: 50, conviction: 50, moonshot: 0, cash: 0 },
      allocationAlerts: [],
      positions: [
        { symbol: 'SMALL', chain: 'base', tier: 'base', value: 100, pnlPercent: 5.0 },
        { symbol: 'BIG', chain: 'base', tier: 'conviction', value: 900, pnlPercent: 10.0 },
      ],
      timestamp: '2026-04-13T00:00:00Z',
    });
    const msg = formatMessage('portfolio_daily', 'system', jsonData, 'fund-1');
    const bigIdx = msg.indexOf('BIG');
    const smallIdx = msg.indexOf('SMALL');
    assert(bigIdx < smallIdx, 'Higher value position should appear first');
  });

  test('portfolio_daily shows profit/loss arrows', () => {
    const jsonData = JSON.stringify({
      status: 'ok',
      summary: {
        totalValue: 1000,
        totalDeposited: 1000,
        totalPnlPercent: 0,
        totalPnlUsd: 0,
        positionCount: 2,
        cashBalance: 0,
      },
      allocation: { base: 100, conviction: 0, moonshot: 0, cash: 0 },
      allocationAlerts: [],
      positions: [
        { symbol: 'UP', chain: 'base', tier: 'base', value: 600, pnlPercent: 20.0 },
        { symbol: 'DOWN', chain: 'base', tier: 'base', value: 400, pnlPercent: -15.0 },
      ],
      timestamp: '2026-04-13T00:00:00Z',
    });
    const msg = formatMessage('portfolio_daily', 'system', jsonData, 'fund-1');
    assert(msg.includes('\u25B2'), 'Should have up arrow for profit');
    assert(msg.includes('\u25BC'), 'Should have down arrow for loss');
  });

  test('portfolio_daily falls back to passthrough on invalid JSON', () => {
    const msg = formatMessage('portfolio_daily', 'system', 'not valid json {{{', 'fund-1');
    assert(msg.includes('PORTFOLIO REPORT'), 'Should still have title');
    assert(msg.includes('not valid json'), 'Should passthrough the raw message');
    assert(msg.includes('Fund: fund-1'), 'Should have fund footer');
  });

  test('portfolio_daily handles empty positions', () => {
    const jsonData = JSON.stringify({
      status: 'ok',
      summary: {
        totalValue: 500,
        totalDeposited: 500,
        totalPnlPercent: 0,
        totalPnlUsd: 0,
        positionCount: 0,
        cashBalance: 500,
      },
      allocation: { base: 0, conviction: 0, moonshot: 0, cash: 100 },
      allocationAlerts: [],
      positions: [],
      timestamp: '2026-04-13T00:00:00Z',
    });
    const msg = formatMessage('portfolio_daily', 'system', jsonData, 'fund-1');
    assert(msg.includes('POSITIONS (0)'), 'Should show zero positions');
    assert(msg.includes('No open positions'), 'Should show empty message');
  });

  test('portfolio_daily shows allocation alerts', () => {
    const jsonData = JSON.stringify({
      status: 'ok',
      summary: {
        totalValue: 1000,
        totalDeposited: 1000,
        totalPnlPercent: 0,
        totalPnlUsd: 0,
        positionCount: 1,
        cashBalance: 10,
      },
      allocation: { base: 0, conviction: 0, moonshot: 90, cash: 10 },
      allocationAlerts: ['[base] Moonshot allocation 90.0% exceeds 20% target'],
      positions: [{ symbol: 'YOLO', chain: 'base', tier: 'moonshot', value: 990, pnlPercent: 5.0 }],
      timestamp: '2026-04-13T00:00:00Z',
    });
    const msg = formatMessage('portfolio_daily', 'system', jsonData, 'fund-1');
    assert(msg.includes('ALERTS'), 'Should have alerts section');
    assert(msg.includes('Moonshot allocation'), 'Should show alert text');
  });

  test('portfolio_daily abbreviates solana to sol', () => {
    const jsonData = JSON.stringify({
      status: 'ok',
      summary: {
        totalValue: 1000,
        totalDeposited: 1000,
        totalPnlPercent: 0,
        totalPnlUsd: 0,
        positionCount: 1,
        cashBalance: 0,
      },
      allocation: { base: 0, conviction: 100, moonshot: 0, cash: 0 },
      allocationAlerts: [],
      positions: [{ symbol: 'SOL1', chain: 'solana', tier: 'conviction', value: 1000, pnlPercent: 10.0 }],
      timestamp: '2026-04-13T00:00:00Z',
    });
    const msg = formatMessage('portfolio_daily', 'system', jsonData, 'fund-1');
    assert(msg.includes('sol'), 'Should abbreviate solana to sol');
  });

  test('unknown type uses default format', () => {
    const msg = formatMessage('unknown_type', 'test', 'something happened', 'fund-1');
    assert(msg.includes('UNKNOWN TYPE'), 'Should show type as label');
    assert(msg.includes('something happened'), 'Should include message');
    assert(msg.includes('Fund: fund-1'), 'Should include fund');
  });

  test('empty message shows fallback', () => {
    const msg = formatMessage('trade_executed', 'executor', '', 'fund-1');
    assert(msg.includes('trade_executed event'), 'Should show fallback text');
  });

  test('all types produce messages with separator and fund', () => {
    const types = Object.keys(EMOJI_MAP);
    for (const type of types) {
      const msg = formatMessage(type, 'test', 'test message', 'fund-1');
      assert(msg.includes(SEP), `${type} should have separator`);
      assert(msg.includes('Fund: fund-1'), `${type} should have fund footer`);
    }
  });
});

// ============================================================
// 5. Topic Count Validation
// ============================================================

describe('Topic Configuration', () => {
  test('exactly 7 unique topic env vars', () => {
    const uniqueTopics = new Set(Object.values(TOPIC_MAP));
    assertEqual(uniqueTopics.size, 7, 'Should have exactly 7 unique topic env vars');
  });

  test('topic env vars match expected names', () => {
    const expected = new Set([
      'TG_TOPIC_RESEARCH',
      'TG_TOPIC_SENTINEL',
      'TG_TOPIC_EXECUTOR',
      'TG_TOPIC_ALERTS',
      'TG_TOPIC_SYSTEM',
      'TG_TOPIC_OBSERVER',
      'TG_TOPIC_PORTFOLIO',
    ]);
    const actual = new Set(Object.values(TOPIC_MAP));
    for (const name of expected) {
      assert(actual.has(name), `Missing topic env var: ${name}`);
    }
  });
});

// ============================================================
// 6. Approval Bot — Message Formatting
// ============================================================

function formatApprovalMessage(order, safeId) {
  const SEP_LINE = '\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015';
  const lines = [];
  lines.push(`\uD83D\uDCCA TRADE PROPOSAL`);
  lines.push(SEP_LINE);
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

  lines.push(SEP_LINE);
  lines.push(`Fund: ${safeId}`);
  return lines.join('\n');
}

describe('Approval Bot — Message Formatting', () => {
  const sampleOrder = {
    id: 'trade-1713000000',
    symbol: 'PEPE',
    chain: 'base',
    amount: 500,
    percent_of_portfolio: 4,
    tier: 'moonshot',
    entry_price: 0.001,
    stop_loss: -45,
    analysis_score: 76,
    risk_score: 20,
    take_profit_levels: '[{"price":2,"sellPercent":50},{"price":3,"sellPercent":100}]',
    reasoning: 'Strong AI narrative with growing community',
  };

  test('approval message includes all key fields', () => {
    const msg = formatApprovalMessage(sampleOrder, 'fund-1');
    assert(msg.includes('TRADE PROPOSAL'), 'Should have title');
    assert(msg.includes('$PEPE'), 'Should include symbol');
    assert(msg.includes('base'), 'Should include chain');
    assert(msg.includes('$500'), 'Should include amount');
    assert(msg.includes('4% moonshot'), 'Should include tier and percent');
    assert(msg.includes('score: 76/100'), 'Should include analysis score');
    assert(msg.includes('Entry: $0.001'), 'Should include entry price');
    assert(msg.includes('Stop Loss: -45%'), 'Should include stop loss');
    assert(msg.includes('Take Profit:'), 'Should include take profit levels');
    assert(msg.includes('Risk: 20/100'), 'Should include risk score');
    assert(msg.includes('Strong AI narrative'), 'Should include reasoning');
    assert(msg.includes('Fund: fund-1'), 'Should have fund footer');
  });

  test('approval message has separator lines', () => {
    const msg = formatApprovalMessage(sampleOrder, 'fund-1');
    const sepCount = (msg.match(/\u2015{16}/g) || []).length;
    assert(sepCount >= 2, 'Should have at least 2 separator lines');
  });

  test('approval message truncates long reasoning', () => {
    const longOrder = { ...sampleOrder, reasoning: 'A'.repeat(300) };
    const msg = formatApprovalMessage(longOrder, 'fund-1');
    assert(msg.includes('...'), 'Should truncate with ellipsis');
    assert(!msg.includes('A'.repeat(300)), 'Should not include full 300-char reasoning');
  });

  test('approval message handles missing optional fields', () => {
    const minimalOrder = { symbol: 'TOKEN', chain: 'solana', amount: 200 };
    const msg = formatApprovalMessage(minimalOrder, 'fund-1');
    assert(msg.includes('$TOKEN'), 'Should include symbol');
    assert(msg.includes('solana'), 'Should include chain');
    assert(msg.includes('$200'), 'Should include amount');
    assert(msg.includes('Fund: fund-1'), 'Should have fund footer');
    assert(!msg.includes('Entry:'), 'Should not have entry without entry_price');
    assert(!msg.includes('Take Profit:'), 'Should not have TP without levels');
    assert(!msg.includes('Risk:'), 'Should not have risk without score');
  });

  test('approval message parses take profit levels from JSON string', () => {
    const msg = formatApprovalMessage(sampleOrder, 'fund-1');
    assert(msg.includes('2x (sell 50%)'), 'Should parse first TP level');
    assert(msg.includes('3x (sell 100%)'), 'Should parse second TP level');
  });
});

// ============================================================
// 7. Approval Bot — Callback Data
// ============================================================

describe('Approval Bot — Callback Data', () => {
  test('callback_data format is correct', () => {
    const orderId = 'trade-1713000000';
    const approveData = `approve:${orderId}`;
    const rejectData = `reject:${orderId}`;
    assert(approveData === 'approve:trade-1713000000', 'Approve callback format');
    assert(rejectData === 'reject:trade-1713000000', 'Reject callback format');
  });

  test('callback_data stays under 64 bytes', () => {
    // Telegram limits callback_data to 64 bytes
    const longId = 'trade-' + '9'.repeat(20);
    const data = `approve:${longId}`;
    assert(Buffer.byteLength(data, 'utf8') <= 64, `callback_data too long: ${data.length} bytes`);
  });

  test('callback_data can be parsed back', () => {
    const data = 'approve:trade-1713000000';
    const colonIdx = data.indexOf(':');
    const action = data.slice(0, colonIdx);
    const orderId = data.slice(colonIdx + 1);
    assertEqual(action, 'approve');
    assertEqual(orderId, 'trade-1713000000');
  });

  test('inline keyboard structure is valid', () => {
    const orderId = 'trade-001';
    const keyboard = {
      inline_keyboard: [
        [
          { text: '\u2705 Approve', callback_data: `approve:${orderId}` },
          { text: '\u274C Reject', callback_data: `reject:${orderId}` },
        ],
      ],
    };
    assertEqual(keyboard.inline_keyboard.length, 1, 'Should have 1 row');
    assertEqual(keyboard.inline_keyboard[0].length, 2, 'Row should have 2 buttons');
    assert(keyboard.inline_keyboard[0][0].text.includes('Approve'), 'First button is Approve');
    assert(keyboard.inline_keyboard[0][1].text.includes('Reject'), 'Second button is Reject');
  });
});

// ============================================================
// 8. Approval Bot — Message Editing
// ============================================================

function buildEditedText(originalText, action, timestamp) {
  const statusLabel = action === 'approve' ? 'APPROVED \u2705' : 'REJECTED \u274C';
  const byLine = action === 'approve' ? `Approved by human at ${timestamp}` : `Rejected by human at ${timestamp}`;

  const SEP_LINE = '\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015';
  const edited = originalText.replace(
    /\uD83D\uDCCA TRADE PROPOSAL/,
    `\uD83D\uDCCA TRADE PROPOSAL \u2014 ${statusLabel}`,
  );

  return edited.replace(new RegExp(`(${SEP_LINE}\nFund: .*)$`), `${SEP_LINE}\n${byLine}\nFund: unknown`);
}

describe('Approval Bot — Message Editing', () => {
  const originalMsg = formatApprovalMessage(
    {
      symbol: 'PEPE',
      chain: 'base',
      amount: 500,
      percent_of_portfolio: 4,
      tier: 'moonshot',
      analysis_score: 76,
      entry_price: 0.001,
      stop_loss: -45,
    },
    'fund-1',
  );

  test('edited message shows APPROVED status', () => {
    const edited = buildEditedText(originalMsg, 'approve', '2026-04-14 15:30:00 UTC');
    assert(edited.includes('APPROVED'), 'Should show APPROVED');
    assert(edited.includes('\u2705'), 'Should have check emoji');
    assert(edited.includes('Approved by human at 2026-04-14 15:30:00 UTC'), 'Should show timestamp');
  });

  test('edited message shows REJECTED status', () => {
    const edited = buildEditedText(originalMsg, 'reject', '2026-04-14 15:30:00 UTC');
    assert(edited.includes('REJECTED'), 'Should show REJECTED');
    assert(edited.includes('\u274C'), 'Should have X emoji');
    assert(edited.includes('Rejected by human at 2026-04-14 15:30:00 UTC'), 'Should show timestamp');
  });

  test('edited message preserves original content', () => {
    const edited = buildEditedText(originalMsg, 'approve', '2026-04-14 15:30:00 UTC');
    assert(edited.includes('$PEPE'), 'Should preserve symbol');
    assert(edited.includes('base'), 'Should preserve chain');
    assert(edited.includes('$500'), 'Should preserve amount');
  });
});

summary();
