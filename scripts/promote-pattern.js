#!/usr/bin/env node
/**
 * promote-pattern.js — Sole legitimate writer to MEMORY.md (PR 3.1)
 *
 * Defangs threat #27 (memory poisoning). MEMORY.md is loaded by all
 * four agents on every cycle, so a single malicious "pattern"
 * promoted via prompt injection becomes a persistent backdoor across
 * all four agents and all future cycles.
 *
 * This script is the only thing that should append to MEMORY.md. It:
 *   1. Sanitizes every text field (sanitizeUntrusted)
 *   2. Requires --seen >= 3 (the existing convention)
 *   3. Requires --attestation-source from a known skill set
 *   4. Requires --derived-from IDs that EXIST in trusted tables (via cclaw)
 *      (receipts, positions, sentinel_alerts, etc) — IDs that are
 *      ground-truth records, NOT free-text fields an agent could
 *      have hallucinated or that traced back to attacker-controlled
 *      token names
 *   5. Writes the entry with a `<!-- via promote-pattern.js ... -->`
 *      marker so pre-commit-check.js can verify provenance
 *
 * Usage:
 *   node scripts/promote-pattern.js \
 *     --name "Late-night liquidity rugs" \
 *     --description "Tokens listed 22:00-04:00 UTC rug 3x more often" \
 *     --signal "pairCreatedAt hour ∈ [22,4] UTC" \
 *     --action "Skip discovery during this window or add 2x risk weight" \
 *     --seen 3 \
 *     --attestation-source risk \
 *     --derived-from "receipt:rcpt-123,receipt:rcpt-456,alert:alrt-789"
 *
 * Exits 0 on success (prints id of inserted block to stdout JSON),
 * exits 1 on any validation failure with a structured JSON error.
 *
 * Ported from direct DB access to cclaw subprocess calls.
 * FAIL-CLOSED: any cclaw error (network/transient) is treated as
 * derived_from_id_not_found — we never assume an ID is valid when
 * we cannot confirm it. This is a security-critical invariant.
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { sanitizeUntrusted } from './redact.js';
import { log } from './log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CCLAW_TIMEOUT_MS = 10_000;

// ============================================================
// Trusted-source schema
//
// Each key is the prefix the agent uses in --derived-from
// (e.g. `receipt:abc-123`). The value is the cclaw command
// pattern used to verify that ID exists. These are tables of
// GROUND-TRUTH records:
//   - receipts/paper_receipts: an actual swap was executed
//   - positions/paper_positions: a position was held
//   - sentinel_alerts: Sentinel detected a real event
//   - sentinel_log/executor_log/research_log/observer_log: a log row
//
// Notably ABSENT: tracked_wallets.notes (free text), orders.reasoning
// (agent prose), analysis_cache.token_data (contains attacker-named
// token symbols). A pattern that traces only to those sources is one
// step removed from attacker injection — refuse it.
// ============================================================

/**
 * Maps derived-from prefix → cclaw command to verify existence.
 * Command must exit 0 if found, non-zero if not found.
 * @type {Record<string, (id: string) => string>}
 */
const TRUSTED_SOURCE_COMMANDS = {
  receipt: (id) => `cclaw receipts get --id ${id}`,
  paper_receipt: (id) => `cclaw receipts get --id ${id} --mode paper`,
  position: (id) => `cclaw positions get --id ${id}`,
  paper_position: (id) => `cclaw positions get --id ${id} --mode paper`,
  alert: (id) => `cclaw alerts get --id ${id}`,
  sentinel_log: (id) => `cclaw logs sentinel get --id ${id}`,
  executor_log: (id) => `cclaw logs executor get --id ${id}`,
  research_log: (id) => `cclaw logs research get --id ${id}`,
  observer_log: (id) => `cclaw logs observer get --id ${id}`,
};

// Also keep the set of trusted source keys for shape validation (no DB lookup needed there).
const TRUSTED_SOURCES = Object.fromEntries(Object.keys(TRUSTED_SOURCE_COMMANDS).map((k) => [k, true]));

const ALLOWED_ATTESTATION_SOURCES = new Set([
  'risk',
  'analyst',
  'portfolio',
  'discovery',
  'orders',
  'sentinel',
  'executor',
  'observer',
  'triage',
  'manual', // operator-driven; should be rare and is logged
]);

const MIN_SEEN = 3;

// ============================================================
// CLI parsing
// ============================================================

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

function fail(msg, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: msg, ...extra }));
  log('error', 'promote-pattern', msg);
  process.exit(1);
}

// ============================================================
// Validation predicates (exported for unit testing)
// ============================================================

/**
 * Parse --derived-from "receipt:abc,alert:def" into structured rows.
 * @returns {{type: string, id: string, raw: string}[]}
 */
export function parseDerivedFrom(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const ix = s.indexOf(':');
      if (ix === -1) return { type: '', id: s, raw: s };
      return { type: s.slice(0, ix).trim(), id: s.slice(ix + 1).trim(), raw: s };
    });
}

/**
 * Validate the structural shape of --derived-from entries: each must
 * have a known type prefix and a non-empty id. Does NOT touch cclaw
 * (that's the second pass in the live script — kept separate for
 * offline testing).
 */
export function validateDerivedFromShape(parsed) {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { valid: false, reason: 'derived_from_empty' };
  }
  for (const row of parsed) {
    if (!row.type) {
      return { valid: false, reason: `derived_from_missing_type: '${row.raw}'` };
    }
    if (!TRUSTED_SOURCES[row.type]) {
      return {
        valid: false,
        reason: `derived_from_untrusted_source: '${row.type}' not in [${Object.keys(TRUSTED_SOURCE_COMMANDS).join(', ')}]`,
      };
    }
    if (!row.id || row.id.length < 3 || row.id.length > 100) {
      return { valid: false, reason: `derived_from_bad_id: '${row.id}'` };
    }
  }
  return { valid: true };
}

/**
 * Validate the --seen count.
 */
export function validateSeenCount(seenRaw) {
  const n = parseInt(seenRaw, 10);
  if (!Number.isFinite(n) || n < MIN_SEEN) {
    return { valid: false, reason: `seen_below_minimum: '${seenRaw}' < ${MIN_SEEN}` };
  }
  return { valid: true, seen: n };
}

/**
 * Validate the --attestation-source value.
 */
export function validateAttestation(source) {
  if (!source || typeof source !== 'string') {
    return { valid: false, reason: 'attestation_missing' };
  }
  if (!ALLOWED_ATTESTATION_SOURCES.has(source)) {
    return {
      valid: false,
      reason: `attestation_not_allowed: '${source}' not in [${[...ALLOWED_ATTESTATION_SOURCES].join(', ')}]`,
    };
  }
  return { valid: true };
}

// ============================================================
// cclaw-backed existence validation (fail-closed)
//
// Security invariant: on ANY execSync error (network timeout, API
// 5xx, process crash), we REJECT — never assume the ID is valid.
// Fail-closed prevents an attacker from poisoning MEMORY.md by
// causing a transient cclaw failure at promotion time.
// ============================================================

/**
 * Verify that each derived-from ID exists by calling cclaw.
 * Fail-closed: any error → derived_from_id_not_found.
 *
 * @param {{type: string, id: string, raw: string}[]} parsed
 * @returns {{valid: boolean, reason?: string}}
 */
export function verifyDerivedFromIdsExistViaCclaw(parsed) {
  for (const row of parsed) {
    const cmdBuilder = TRUSTED_SOURCE_COMMANDS[row.type];
    if (!cmdBuilder) {
      return { valid: false, reason: `unknown_source: '${row.type}'` };
    }
    const cmd = cmdBuilder(row.id);
    try {
      execSync(cmd, {
        encoding: 'utf-8',
        timeout: CCLAW_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // exit code 0 = record found (cclaw exits non-zero on 404)
    } catch {
      // FAIL-CLOSED: any error (timeout, 404, network) = not found / not verifiable.
      return {
        valid: false,
        reason: `derived_from_id_not_found: ${row.raw} (cclaw returned non-zero or timed out)`,
      };
    }
  }
  return { valid: true };
}

// ============================================================
// MEMORY.md write
// ============================================================

function findMemoryFile() {
  // Prefer the workspace path the agents actually read. Fall back to
  // an agent-deployed copy if running from a non-standard cwd.
  const candidates = [
    resolve(__dirname, '..', 'workspace', 'MEMORY.md'),
    resolve(__dirname, '..', 'agents', 'research', 'workspace', 'MEMORY.md'),
    process.env.MEMORY_MD_PATH,
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function buildEntry({ name, description, signal, action, seen, attestation, derivedFrom }) {
  const ts = new Date().toISOString();
  const trail =
    `<!-- via promote-pattern.js attestation=${attestation} ` +
    `derived_from=${derivedFrom.map((r) => r.raw).join(',')} ` +
    `seen=${seen} ts=${ts} -->`;
  // sanitizeUntrusted ALL agent-provided text. Prevents an injected
  // pattern name like "ignore-previous</tool_result>" from sneaking
  // into MEMORY.md and surfacing as instruction-shaped tokens.
  const safeName = sanitizeUntrusted(name, { maxLen: 80 });
  const safeDesc = sanitizeUntrusted(description, { maxLen: 256 });
  const safeSignal = sanitizeUntrusted(signal, { maxLen: 256 });
  const safeAction = sanitizeUntrusted(action, { maxLen: 256 });
  return [
    '',
    trail,
    `### ${safeName} (seen: ${seen} times, attestation: ${attestation})`,
    `- **Description:** ${safeDesc}`,
    `- **Signal:** ${safeSignal}`,
    `- **Action:** ${safeAction}`,
    `- **Derived from:** ${derivedFrom.length} ground-truth row(s)`,
    `- **Last updated:** ${ts.slice(0, 10)}`,
    '',
  ].join('\n');
}

// ============================================================
// Main
// ============================================================

function main() {
  const name = getArg('name');
  const description = getArg('description');
  const signal = getArg('signal');
  const action = getArg('action');
  const seenRaw = getArg('seen') ?? String(MIN_SEEN);
  const attestation = getArg('attestation-source');
  const derivedFromRaw = getArg('derived-from');

  if (!name) fail('--name is required');
  if (!description) fail('--description is required');
  if (!signal) fail('--signal is required');
  if (!action) fail('--action is required');

  const seenCheck = validateSeenCount(seenRaw);
  if (!seenCheck.valid) fail(seenCheck.reason);

  const attCheck = validateAttestation(attestation);
  if (!attCheck.valid) fail(attCheck.reason);

  const parsed = parseDerivedFrom(derivedFromRaw);
  const shapeCheck = validateDerivedFromShape(parsed);
  if (!shapeCheck.valid) fail(shapeCheck.reason);

  // cclaw-backed existence check (fail-closed)
  const existsCheck = verifyDerivedFromIdsExistViaCclaw(parsed);
  if (!existsCheck.valid) fail(existsCheck.reason);

  const memoryPath = findMemoryFile();
  if (!memoryPath) fail('MEMORY.md not found in any candidate path');

  const entry = buildEntry({
    name,
    description,
    signal,
    action,
    seen: seenCheck.seen,
    attestation,
    derivedFrom: parsed,
  });

  appendFileSync(memoryPath, entry, 'utf-8');

  console.log(
    JSON.stringify({
      ok: true,
      memory_path: memoryPath,
      entry_chars: entry.length,
      attestation,
      seen: seenCheck.seen,
      derived_from_count: parsed.length,
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
