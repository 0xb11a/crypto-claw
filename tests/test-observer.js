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

  test('AGENTS.md contains security rules', () => {
    const content = readFileSync(resolve(AGENTS_DIR, 'AGENTS.md'), 'utf-8');
    assert(content.includes('NEVER include wallet addresses'), 'Should have security rules');
    assert(content.includes('Read-only'), 'Should specify read-only access');
  });

  test('AGENTS.md has deduplication guidance', () => {
    const content = readFileSync(resolve(AGENTS_DIR, 'AGENTS.md'), 'utf-8');
    assert(content.includes('list-issues.js'), 'Should reference dedup via list-issues');
  });

  test('HEARTBEAT.md specifies 60-minute cycle', () => {
    const content = readFileSync(resolve(AGENTS_DIR, 'HEARTBEAT.md'), 'utf-8');
    assert(content.includes('60 minutes'), 'Should specify 60-minute cycle');
  });
});

// ============================================================
// GitHub Integration Scripts Exist
// ============================================================
describe('GitHub Integration Scripts', () => {
  test('create-issue.js exists', () => {
    assert(existsSync(resolve(SCRIPTS_DIR, 'create-issue.js')), 'create-issue.js must exist');
  });

  test('list-issues.js exists', () => {
    assert(existsSync(resolve(SCRIPTS_DIR, 'list-issues.js')), 'list-issues.js must exist');
  });

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
summary();
