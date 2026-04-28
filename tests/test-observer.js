#!/usr/bin/env node
/**
 * Test Suite: Observer Agent System
 *
 * Tests:
 * 1. Redaction module (sensitive data stripping)
 * 2. Log helper (format, rotation logic)
 * 3. Observer log table (CRUD via db-query.js)
 * 4. Observer agent files exist
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { describe, test, assert, assertEqual, summary } from './test-helpers.js';

const SCRIPTS_DIR = resolve(process.cwd(), 'scripts');
const AGENTS_DIR = resolve(process.cwd(), 'agents/observer');

// ============================================================
// Redaction Module
// ============================================================
// Pre-load redact module (ESM)
const { redact } = await import('../scripts/redact.js');

describe('Redaction — Sensitive Data Stripping', () => {
  test('redact module loads', () => {
    assert(typeof redact === 'function', 'redact should be a function');
  });

  test('redacts ETH addresses (0x + 40 hex)', () => {
    const input = 'Transfer to 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 completed';
    const result = redact(input);
    assert(!result.includes('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), 'ETH address should be redacted');
    assert(result.includes('[REDACTED_ADDR]'), 'Should contain REDACTED_ADDR placeholder');
  });

  test('redacts ETH private keys (0x + 64 hex)', () => {
    const input = 'Key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // pre-commit-allow
    const result = redact(input);
    assert(!result.includes('ac0974bec'), 'Private key should be redacted');
    assert(result.includes('[REDACTED_KEY]'), 'Should contain REDACTED_KEY placeholder');
  });

  test('redacts API keys (sk-...)', () => {
    const input = 'API key: sk-ant-api03-abcdefghijklmnop123456'; // pre-commit-allow
    const result = redact(input);
    assert(!result.includes('sk-ant-api03'), 'API key should be redacted');
    assert(result.includes('[REDACTED_API_KEY]'), 'Should contain REDACTED_API_KEY placeholder');
  });

  test('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123'; // pre-commit-allow
    const result = redact(input);
    assert(!result.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'Bearer token should be redacted');
    assert(result.includes('[REDACTED_TOKEN]'), 'Should contain REDACTED_TOKEN placeholder');
  });

  test('redacts extended private keys (xprv...)', () => {
    const input =
      'Key: xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi'; // pre-commit-allow
    const result = redact(input);
    assert(!result.includes('xprv9s21ZrQH143K3'), 'Extended private key should be redacted');
    assert(result.includes('[REDACTED_XPRV]'), 'Should contain REDACTED_XPRV placeholder');
  });

  test('redacts standalone 64-char hex strings (likely keys/hashes)', () => {
    const input = 'Hash: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const result = redact(input);
    assert(
      !result.includes('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'),
      'Hex secret should be redacted',
    );
  });

  test('preserves normal text', () => {
    const input = 'BUY validation_failed: insufficient_cash: have $50, need $500';
    const result = redact(input);
    assertEqual(result, input, 'Normal text should be preserved');
  });

  test('preserves known safe words', () => {
    const input = 'Status: validation_failed, queued_in_safe, tx_failed';
    const result = redact(input);
    assert(result.includes('validation_failed'), 'Should preserve validation_failed');
    assert(result.includes('queued_in_safe'), 'Should preserve queued_in_safe');
    assert(result.includes('tx_failed'), 'Should preserve tx_failed');
  });

  test('handles null/undefined input', () => {
    const result1 = redact(null);
    const result2 = redact(undefined);
    const result3 = redact('');
    assertEqual(result1, '', 'null should return empty string');
    assertEqual(result2, '', 'undefined should return empty string');
    assertEqual(result3, '', 'empty string should return empty string');
  });

  test('redacts multiple sensitive values in one string', () => {
    const input = 'Transfer from 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 with key sk-test-abcdefghijklmnop12345'; // pre-commit-allow
    const result = redact(input);
    assert(!result.includes('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), 'Address should be redacted');
    assert(!result.includes('sk-test'), 'API key should be redacted');
  });
});

// ============================================================
// Observer Log Table
// ============================================================
describe('Observer Log — Database CRUD', () => {
  const dbQuery = (cmd) => {
    return execSync(`SAFE_ID=test-observer node ${resolve(SCRIPTS_DIR, 'db-query.js')} ${cmd}`, {
      encoding: 'utf-8',
      cwd: process.cwd(),
      timeout: 10_000,
    }).trim();
  };

  test('add-observer-log creates an entry', () => {
    const result = JSON.parse(
      dbQuery(
        'add-observer-log --json \'{"errors_analyzed": 5, "issues_created": 1, "alerts_sent": 0, "summary": "Test cycle", "status": "ok"}\'',
      ),
    );
    assert(result.ok === true, 'Should return ok: true');
  });

  test('get-observer-log retrieves entries', () => {
    const rows = JSON.parse(dbQuery('get-observer-log --limit 5'));
    assert(Array.isArray(rows), 'Should return an array');
    assert(rows.length >= 1, 'Should have at least 1 entry');
    const latest = rows[0];
    assertEqual(latest.errors_analyzed, 5, 'errors_analyzed should be 5');
    assertEqual(latest.issues_created, 1, 'issues_created should be 1');
    assertEqual(latest.status, 'ok', 'status should be ok');
    assert(latest.summary === 'Test cycle', 'summary should match');
  });

  // Clean up test database
  test('cleanup test database', () => {
    try {
      unlinkSync(resolve(process.cwd(), 'data', 'test-observer.db'));
    } catch {}
    assert(true, 'cleanup done');
  });
});

// ============================================================
// Observer Agent Files
// ============================================================
describe('Observer Agent — File Structure', () => {
  test('AGENTS.md exists', () => {
    assert(existsSync(resolve(AGENTS_DIR, 'AGENTS.md')), 'AGENTS.md must exist');
  });

  test('SOUL.md exists', () => {
    assert(existsSync(resolve(AGENTS_DIR, 'SOUL.md')), 'SOUL.md must exist');
  });

  test('HEARTBEAT.md exists', () => {
    assert(existsSync(resolve(AGENTS_DIR, 'HEARTBEAT.md')), 'HEARTBEAT.md must exist');
  });

  test('TOOLS.md exists', () => {
    assert(existsSync(resolve(AGENTS_DIR, 'TOOLS.md')), 'TOOLS.md must exist');
  });

  test('skills/triage/SKILL.md exists', () => {
    assert(existsSync(resolve(AGENTS_DIR, 'skills/triage/SKILL.md')), 'triage skill must exist');
  });

  test('skills/create-gh-issue/SKILL.md exists', () => {
    assert(existsSync(resolve(AGENTS_DIR, 'skills/create-gh-issue/SKILL.md')), 'create-gh-issue skill must exist');
  });

  test('create-gh-issue skill has mandatory duplicate check', () => {
    const content = readFileSync(resolve(AGENTS_DIR, 'skills/create-gh-issue/SKILL.md'), 'utf-8');
    assert(content.includes('NEVER skip the duplicate check'), 'Should enforce mandatory dedup');
    assert(content.includes('gh issue list'), 'Should fetch open issues before creating');
    assert(content.includes('gh issue comment'), 'Should comment on duplicates instead of creating');
  });

  test('triage skill delegates to create-gh-issue', () => {
    const content = readFileSync(resolve(AGENTS_DIR, 'skills/triage/SKILL.md'), 'utf-8');
    assert(content.includes('create-gh-issue'), 'Should reference create-gh-issue skill');
    assert(!content.includes('gh issue create'), 'Should not use gh issue create directly');
  });

  test('AGENTS.md contains security rules', () => {
    const content = readFileSync(resolve(AGENTS_DIR, 'AGENTS.md'), 'utf-8');
    assert(content.includes('NEVER include wallet addresses'), 'Should have security rules');
    assert(content.includes('Read-only'), 'Should specify read-only access');
  });

  test('AGENTS.md has deduplication guidance', () => {
    const content = readFileSync(resolve(AGENTS_DIR, 'AGENTS.md'), 'utf-8');
    assert(content.includes('gh issue list'), 'Should reference dedup via gh issue list');
  });

  test('HEARTBEAT.md specifies 120-minute cycle', () => {
    const content = readFileSync(resolve(AGENTS_DIR, 'HEARTBEAT.md'), 'utf-8');
    assert(content.includes('120 minutes'), 'Should specify 120-minute cycle');
  });
});

// ============================================================
// GitHub Integration (gh CLI, authenticated at container startup)
// ============================================================
describe('GitHub Integration', () => {
  test('redact.js exists', () => {
    assert(existsSync(resolve(SCRIPTS_DIR, 'redact.js')), 'redact.js must exist');
  });

  test('log.js exists', () => {
    assert(existsSync(resolve(SCRIPTS_DIR, 'log.js')), 'log.js must exist');
  });
});

// ============================================================
// Signer Balance Monitoring
// ============================================================
describe('Signer Balance Monitoring', () => {
  test('check-signer-balances.js exists', () => {
    assert(existsSync(resolve(SCRIPTS_DIR, 'check-signer-balances.js')), 'check-signer-balances.js must exist');
  });

  test('outputs valid JSON with no keys set (graceful skip)', () => {
    const output = execSync(`node ${resolve(SCRIPTS_DIR, 'check-signer-balances.js')}`, {
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, SAFE_SIGNER_KEY: '', SQUADS_SIGNER_KEY: '', SQUADS_MULTISIG_ADDRESS: '' },
    }).trim();
    const result = JSON.parse(output);
    assertEqual(result.status, 'ok');
    assert(Array.isArray(result.signerBalances), 'Should have signerBalances array');
    assertEqual(result.anyBelowThreshold, false);
  });

  test('output never contains private key material', () => {
    // Hardhat test account #0 — not a real key
    const fakeKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // pre-commit-allow
    const output = execSync(`node ${resolve(SCRIPTS_DIR, 'check-signer-balances.js')}`, {
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, SAFE_SIGNER_KEY: fakeKey, SQUADS_SIGNER_KEY: '', SQUADS_MULTISIG_ADDRESS: '' },
    }).trim();
    assert(!output.includes('ac0974bec'), 'Output must never contain private key material');
    assert(!output.includes('bacb478'), 'Output must never contain private key fragments');
  });
});

// ============================================================
// Instruction Alignment — severity rubric + Error Self-Reporting
// ============================================================
describe('Instruction Alignment — Severity Rubric and Error Self-Reporting', () => {
  const WORKSPACE_DIR = resolve(process.cwd(), 'workspace');
  const AGENTS_ROOT = resolve(process.cwd(), 'agents');

  test('workspace/TOOLS.md has Logging Severity Rubric', () => {
    const content = readFileSync(resolve(WORKSPACE_DIR, 'TOOLS.md'), 'utf-8');
    assert(content.includes('## Logging Severity Rubric'), 'Should have canonical rubric section');
    assert(
      content.includes('`info`') &&
        content.includes('`warn`') &&
        content.includes('`error`') &&
        content.includes('`critical`'),
      'Should document all four levels',
    );
  });

  test('each agent TOOLS.md mirrors the rubric', () => {
    for (const agent of ['research', 'sentinel', 'executor', 'observer']) {
      const content = readFileSync(resolve(AGENTS_ROOT, agent, 'TOOLS.md'), 'utf-8');
      assert(content.includes('Logging Severity Rubric'), `${agent}/TOOLS.md should have severity rubric`);
    }
  });

  test('all four AGENTS.md have grep-auditable self-reporting sentence', () => {
    const sentence = 'Silent failure is the worst failure';
    for (const agent of ['research', 'sentinel', 'executor', 'observer']) {
      const content = readFileSync(resolve(AGENTS_ROOT, agent, 'AGENTS.md'), 'utf-8');
      assert(content.includes(sentence), `${agent}/AGENTS.md should contain the canonical self-reporting sentence`);
    }
  });

  test('Observer AGENTS.md has new decision framework rows', () => {
    const content = readFileSync(resolve(AGENTS_ROOT, 'observer/AGENTS.md'), 'utf-8');
    assert(content.includes('Silent crash'), 'Should have silent-crash decision row');
    assert(content.includes('Stale approved order'), 'Should have stale-order decision row');
    assert(content.includes('Dead agent'), 'Should have dead-agent decision row');
    assert(content.includes('Orphan approved trade'), 'Should have orphan-trade decision row');
    assert(content.includes('Memory-backup heartbeat stale'), 'Should have memory-backup decision row');
  });

  test('Observer HEARTBEAT.md scans [warn] [error] [critical]', () => {
    const content = readFileSync(resolve(AGENTS_ROOT, 'observer/HEARTBEAT.md'), 'utf-8');
    assert(
      content.includes('[warn]') && content.includes('[error]') && content.includes('[critical]'),
      'Should document all three levels',
    );
  });

  test('Observer HEARTBEAT.md has new scan steps (silent-crash, stale-order, dead-agent, stuck-token)', () => {
    const content = readFileSync(resolve(AGENTS_ROOT, 'observer/HEARTBEAT.md'), 'utf-8');
    assert(content.includes('Silent-Crash Scan'), 'Should have silent-crash scan step');
    assert(content.includes('Stale-Order Scan'), 'Should have stale-order scan step');
    assert(content.includes('Dead-Agent') || content.includes('dead agent'), 'Should have dead-agent scan step');
    assert(content.includes('Stuck-Token'), 'Should have stuck-token scan step');
    assert(content.includes('get-heartbeats'), 'Should use get-heartbeats command');
    assert(content.includes('get-research-log'), 'Should query research_log');
  });

  test('create-gh-issue skill has mandatory Redaction Audit', () => {
    const content = readFileSync(resolve(AGENTS_ROOT, 'observer/skills/create-gh-issue/SKILL.md'), 'utf-8');
    assert(content.includes('Redaction Audit'), 'Should have redaction audit step');
    assert(content.includes('NEVER skip the redaction audit'), 'Should mark it mandatory');
    assert(content.includes('base58'), 'Should include base58 pattern');
  });

  test('Sentinel HEARTBEAT.md has error handling for each check', () => {
    const content = readFileSync(resolve(AGENTS_ROOT, 'sentinel/HEARTBEAT.md'), 'utf-8');
    for (const check of ['price', 'liquidity', 'wallet', 'contract']) {
      const hasCheckErrorHandling = content.includes(`"check_type":"${check}","status":"error"`);
      assert(hasCheckErrorHandling, `Should have error-handling log for ${check} check`);
    }
  });

  test('Executor HEARTBEAT.md has get-orders failure handling', () => {
    const content = readFileSync(resolve(AGENTS_ROOT, 'executor/HEARTBEAT.md'), 'utf-8');
    assert(
      content.includes('get-orders') && content.includes('trade_failed'),
      'Should handle get-orders failure with trade_failed alert',
    );
    assert(content.includes('"status":"error"'), 'Should log status:error on fetch failure');
  });

  test('Research HEARTBEAT.md strengthens error-logging mandate', () => {
    const content = readFileSync(resolve(AGENTS_ROOT, 'research/HEARTBEAT.md'), 'utf-8');
    assert(content.includes('model_failure'), 'Should require model_failure alert on check failure');
    assert(
      content.includes('A failed check with no log row') || content.includes('silent crash'),
      'Should call out silent-crash as a bug',
    );
  });

  test('send-alert.js logs success to system.log (for Observer correlation)', () => {
    const content = readFileSync(resolve(SCRIPTS_DIR, 'send-alert.js'), 'utf-8');
    assert(
      content.includes("log('info', 'send-alert'"),
      'send-alert.js should log at info on success so Observer has a system.log trail',
    );
  });

  test('Executor AGENTS.md + HEARTBEAT.md no longer prescribe log.js CLI invocation', () => {
    const agentsMd = readFileSync(resolve(AGENTS_ROOT, 'executor/AGENTS.md'), 'utf-8');
    const heartbeatMd = readFileSync(resolve(AGENTS_ROOT, 'executor/HEARTBEAT.md'), 'utf-8');
    assert(
      !/log at .\[?critical\]? via .?scripts\/log\.js/i.test(agentsMd),
      'AGENTS.md should not prescribe log.js CLI invocation (log.js is a module)',
    );
    assert(!/Log via .?scripts\/log\.js/.test(heartbeatMd), 'HEARTBEAT.md should not prescribe log.js CLI invocation');
  });

  test('Executor TOOLS.md documents trade_failed and system_health examples', () => {
    const content = readFileSync(resolve(AGENTS_ROOT, 'executor/TOOLS.md'), 'utf-8');
    assert(content.includes('--type trade_failed --agent executor'), 'Should have concrete trade_failed example');
    assert(content.includes('--type system_health --agent executor'), 'Should have concrete system_health example');
  });
});

// ============================================================
// get-heartbeats command (used by Observer for dead-agent detection)
// ============================================================
describe('get-heartbeats — Dead-Agent Detection', () => {
  // Pin PAPER_MODE=false so positions/orders queries hit real tables regardless
  // of the operator's local .env. The same dotenv quirk would let .env win
  // otherwise (dotenv doesn't override pre-set env vars, but undefined ones get
  // filled in from .env — including a PAPER_MODE=true line in dev shells).
  const dbQuery = (cmd) => {
    return execSync(`SAFE_ID=test-observer-hb PAPER_MODE=false node ${resolve(SCRIPTS_DIR, 'db-query.js')} ${cmd}`, {
      encoding: 'utf-8',
      cwd: process.cwd(),
      timeout: 10_000,
    }).trim();
  };

  test('get-heartbeats returns an array with expected shape', () => {
    // First update one heartbeat so there's a row with last_run_at
    dbQuery('update-heartbeat --agent observer --check triage');
    const rows = JSON.parse(dbQuery('get-heartbeats'));
    assert(Array.isArray(rows), 'Should return an array');
    assert(rows.length > 0, 'Should have at least one heartbeat row (seeded by migrations)');
    const sample = rows[0];
    assert('agent' in sample, 'Should have agent field');
    assert('check' in sample, 'Should have check field');
    assert('last_run_at' in sample, 'Should have last_run_at field');
    assert('seconds_since' in sample, 'Should have seconds_since field');
    assert('expected_cadence_seconds' in sample, 'Should have expected_cadence_seconds field');
  });

  test('get-heartbeats --agent filter works', () => {
    const rows = JSON.parse(dbQuery('get-heartbeats --agent observer'));
    assert(Array.isArray(rows), 'Should return an array');
    assert(
      rows.every((r) => r.agent === 'observer'),
      'Should only return observer rows',
    );
  });

  test('seeded system/memory-backup row exists with 15-min cadence', () => {
    const rows = JSON.parse(dbQuery('get-heartbeats --agent system'));
    const backup = rows.find((r) => r.check === 'memory-backup');
    assert(backup, 'Should have system/memory-backup heartbeat row seeded');
    assertEqual(backup.expected_cadence_seconds, 15 * 60, 'memory-backup cadence should be 15 minutes');
  });

  test('seconds_since computed correctly after update', () => {
    dbQuery('update-heartbeat --agent observer --check triage');
    const rows = JSON.parse(dbQuery('get-heartbeats --agent observer'));
    const triage = rows.find((r) => r.check === 'triage');
    assert(triage, 'Should find triage row');
    assert(
      triage.seconds_since !== null && triage.seconds_since < 10,
      'seconds_since should be near zero after fresh update',
    );
  });

  test('0-cadence sentinel checks inherit 15-min agent loop interval', () => {
    const rows = JSON.parse(dbQuery('get-heartbeats --agent sentinel'));
    for (const name of ['price_check', 'liquidity_check', 'wallet_check']) {
      const row = rows.find((r) => r.check === name);
      assert(row, `Should have sentinel/${name} heartbeat row`);
      assertEqual(row.expected_cadence_seconds, 15 * 60, `sentinel/${name} should fall back to sentinel loop (15 min)`);
    }
  });

  test('non-zero sentinel contract_check keeps its own cadence', () => {
    const rows = JSON.parse(dbQuery('get-heartbeats --agent sentinel'));
    const contract = rows.find((r) => r.check === 'contract_check');
    assert(contract, 'Should have sentinel/contract_check heartbeat row');
    assertEqual(contract.expected_cadence_seconds, 30 * 60, 'contract_check should keep its 30-min cadence');
  });

  test('0-cadence executor process_orders inherits 1-min loop interval', () => {
    const rows = JSON.parse(dbQuery('get-heartbeats --agent executor'));
    const row = rows.find((r) => r.check === 'process_orders');
    assert(row, 'Should have executor/process_orders heartbeat row');
    assertEqual(row.expected_cadence_seconds, 60, 'executor/process_orders should fall back to executor loop (1 min)');
  });

  test('idle_ok=true for executor/sentinel when no work pending', () => {
    // Empty DB: no approved orders, no open positions → demand-driven idleness
    const rows = JSON.parse(dbQuery('get-heartbeats'));
    const executor = rows.find((r) => r.agent === 'executor' && r.check === 'process_orders');
    assert(executor, 'Should have executor/process_orders row');
    assertEqual(executor.idle_ok, true, 'executor idle_ok should be true when no approved orders');

    for (const name of ['price_check', 'liquidity_check', 'wallet_check', 'smart_money_exits', 'contract_check']) {
      const row = rows.find((r) => r.agent === 'sentinel' && r.check === name);
      assert(row, `Should have sentinel/${name} row`);
      assertEqual(row.idle_ok, true, `sentinel/${name} idle_ok should be true when no open positions`);
    }
  });

  test('idle_ok=false for non-demand-driven rows (research, observer, system)', () => {
    const rows = JSON.parse(dbQuery('get-heartbeats'));
    const nonDemand = rows.filter((r) => r.agent !== 'executor' && r.agent !== 'sentinel');
    assert(nonDemand.length > 0, 'Should have research/observer/system rows');
    for (const row of nonDemand) {
      assertEqual(
        row.idle_ok,
        false,
        `${row.agent}/${row.check} idle_ok should be false (only executor/sentinel are demand-driven)`,
      );
    }
  });

  test('approved order flips executor idle_ok to false', () => {
    const order = JSON.stringify({
      id: 'test-idle-ok-buy',
      action: 'buy',
      symbol: 'TEST',
      address: '0x0000000000000000000000000000000000000001',
      chain: 'base',
      amount: 100,
      tier: 'moonshot',
      entry_price: 1.0,
      stop_loss: 0.8,
      take_profit_levels: [{ price: 1.5, percent: 100 }],
    });
    // AUTO_APPROVE_BUY=true so the buy lands in 'approved' status
    execSync(
      `SAFE_ID=test-observer-hb PAPER_MODE=false AUTO_APPROVE_BUY=true node ${resolve(SCRIPTS_DIR, 'db-query.js')} add-order --json '${order}'`,
      { encoding: 'utf-8', cwd: process.cwd(), timeout: 10_000 },
    );

    const rows = JSON.parse(dbQuery('get-heartbeats --agent executor'));
    const executor = rows.find((r) => r.check === 'process_orders');
    assertEqual(executor.idle_ok, false, 'executor idle_ok should flip to false once an approved order exists');
  });

  test('open position flips sentinel idle_ok to false', () => {
    const position = JSON.stringify({
      id: 'test-idle-ok-pos',
      symbol: 'TEST',
      name: 'Test Token',
      address: '0x0000000000000000000000000000000000000002',
      chain: 'base',
      tier: 'moonshot',
      entry_price: 1.0,
      current_price: 1.0,
      quantity: 100,
      value_usd: 100,
      percent_of_portfolio: 5,
      stop_loss: 0.8,
      take_profit_levels: [{ price: 1.5, percent: 100 }],
      narrative: 'test',
      status: 'open',
      notes: 'idle_ok test',
    });
    execSync(
      `SAFE_ID=test-observer-hb PAPER_MODE=false node ${resolve(SCRIPTS_DIR, 'db-query.js')} add-position --json '${position}'`,
      { encoding: 'utf-8', cwd: process.cwd(), timeout: 10_000 },
    );

    const rows = JSON.parse(dbQuery('get-heartbeats --agent sentinel'));
    for (const name of ['price_check', 'liquidity_check', 'wallet_check', 'smart_money_exits', 'contract_check']) {
      const row = rows.find((r) => r.check === name);
      assertEqual(row.idle_ok, false, `sentinel/${name} idle_ok should flip to false once an open position exists`);
    }
  });

  test('cleanup get-heartbeats test database', () => {
    try {
      unlinkSync(resolve(process.cwd(), 'data', 'test-observer-hb.db'));
    } catch {}
    assert(true, 'cleanup done');
  });
});

// ============================================================
summary();
