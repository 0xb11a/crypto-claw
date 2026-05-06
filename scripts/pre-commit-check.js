#!/usr/bin/env node
/**
 * pre-commit-check.js — Secret scanner for pre-commit hook
 *
 * Reads staged diff and checks added lines for accidental secrets.
 * Exit 0 = clean, Exit 1 = secrets found.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { PORTFOLIO_RULES, getPortfolioRules } from './chains.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PATTERNS = [
  {
    name: 'hex-private-key',
    pattern: /0x[0-9a-fA-F]{64}\b/,
    description: 'Possible EVM private key (64 hex chars)',
  },
  {
    name: 'base58-private-key',
    pattern: /[1-9A-HJ-NP-Za-km-z]{85,90}/,
    description: 'Possible Solana private key (base58)',
  },
  {
    name: 'openai-key',
    pattern: /sk-[a-zA-Z0-9_-]{20,}/,
    description: 'Possible OpenAI API key',
  },
  {
    name: 'hardcoded-secret-assignment',
    pattern: /(API_KEY|SECRET|SIGNER_KEY|PRIVATE_KEY)\s*=\s*['"][^'"]{8,}['"]/,
    description: 'Hardcoded secret assignment',
  },
  {
    name: 'bearer-token',
    pattern: /Bearer\s+[a-zA-Z0-9_\-.]{20,}/,
    description: 'Possible Bearer token',
  },
  {
    name: 'rpc-with-key',
    pattern: /https?:\/\/.*\.(alchemy|infura)\..*\/[a-zA-Z0-9_-]{10,}/,
    description: 'RPC URL with embedded API key',
  },
];

const PLACEHOLDER_WORDS = ['YOUR_KEY', 'REDACTED', 'example', 'placeholder', '__none__'];

const FAKE_HEX_PATTERNS = [/^0x(deadbeef){8}/, /^0x(00){32}$/, /^0x(ff){32}$/, /^0x(12345678){8}/];

function isComment(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*');
}

function isAllowlisted(line, file) {
  if (file === '.env.example') return true;
  if (isComment(line)) return true;
  if (line.includes('process.env.')) return true;
  if (line.includes('// pre-commit-allow')) return true;
  if (PLACEHOLDER_WORDS.some((w) => line.includes(w))) return true;
  return false;
}

function isFakeHexKey(match) {
  return FAKE_HEX_PATTERNS.some((p) => p.test(match));
}

// ============================================================
// PR 4.4: CLAUDE.md ↔ chains.js safety-rule drift gate.
//
// CLAUDE.md's "Safety Rules (Do Not Weaken)" section duplicates the
// numeric portfolio limits from chains.js PORTFOLIO_RULES. If a
// developer (or LLM) silently relaxes a limit in CLAUDE.md without
// touching chains.js, the prose contradicts the code — agents
// reading CLAUDE.md will plan trades the executor will reject. If
// the relaxation goes the OTHER way (chains.js raised but CLAUDE.md
// not updated), a future refactor that re-derives limits from
// CLAUDE.md prose silently re-tightens. Either way: drift compounds.
//
// This gate blocks the commit on any mismatch.
// ============================================================

// Map of phrases in CLAUDE.md "Safety Rules" → chains.js key, plus
// optional chain override expectations. The phrases are matched
// case-insensitively against the section text.
const CLAUDE_SAFETY_RULES = [
  { phrase: 'Max moonshot position', jsKey: 'maxMoonshotPosition', solanaOverride: 7 },
  { phrase: 'Max conviction position', jsKey: 'maxConvictionPosition' },
  { phrase: 'Max base position', jsKey: 'maxBasePosition' },
  { phrase: 'Max total moonshot allocation', jsKey: 'maxMoonshotAllocation' },
  { phrase: 'Min cash reserve', jsKey: 'minCashReserve' },
  { phrase: 'Max same-narrative positions', jsKey: 'maxSameNarrative' },
];

/**
 * Pure predicate, exported for offline tests. Given the text of
 * CLAUDE.md and a PORTFOLIO_RULES-shaped object, returns the array
 * of mismatches. Empty array = consistent.
 */
export function findSafetyRuleMismatches(claudeMdContent, portfolioRules, chainOverrides = {}) {
  if (!claudeMdContent || typeof claudeMdContent !== 'string') {
    return [{ rule: 'CLAUDE.md', reason: 'unreadable_or_empty' }];
  }
  // Extract the "Safety Rules" section. Stop at the next ## heading
  // or end of file.
  const sectionMatch = claudeMdContent.match(/## Safety Rules[^\n]*\n([\s\S]*?)(?=\n## |\n# |$)/);
  if (!sectionMatch) {
    return [{ rule: 'CLAUDE.md', reason: 'safety_rules_section_missing' }];
  }
  const section = sectionMatch[1];

  const findings = [];
  for (const { phrase, jsKey, solanaOverride } of CLAUDE_SAFETY_RULES) {
    // % is optional — most rules are percentages but maxSameNarrative
    // is a bare count ("Max same-narrative positions: 3").
    const re = new RegExp(`${phrase}:\\s*(\\d+(?:\\.\\d+)?)\\s*%?`, 'i');
    const m = section.match(re);
    const jsValue = portfolioRules[jsKey];
    if (!m) {
      findings.push({
        rule: jsKey,
        phrase,
        mdValue: null,
        jsValue,
        reason: 'phrase_missing_in_claude_md',
      });
      continue;
    }
    const mdValue = parseFloat(m[1]);
    if (mdValue !== jsValue) {
      findings.push({
        rule: jsKey,
        phrase,
        mdValue,
        jsValue,
        reason: 'value_mismatch',
      });
    }

    // Solana override: when phrase has `(Solana: N%)` parenthetical,
    // verify it matches solanaOverride (which itself should match
    // chainOverrides.solana[jsKey] from chains.js).
    if (solanaOverride !== undefined) {
      const overrideRe = new RegExp(`${phrase}:[^\\n]*Solana:\\s*(\\d+(?:\\.\\d+)?)\\s*%`, 'i');
      const om = section.match(overrideRe);
      if (om) {
        const mdSolana = parseFloat(om[1]);
        const expected = chainOverrides.solana?.[jsKey] ?? solanaOverride;
        if (mdSolana !== expected) {
          findings.push({
            rule: `${jsKey} (Solana override)`,
            phrase,
            mdValue: mdSolana,
            jsValue: expected,
            reason: 'solana_override_mismatch',
          });
        }
      }
    }
  }
  return findings;
}

/**
 * File-reading orchestrator. Loads CLAUDE.md from the repo root and
 * runs the predicate against the live PORTFOLIO_RULES.
 */
function runSafetyRuleGate() {
  try {
    const repoRoot = resolve(__dirname, '..');
    const claudeMd = readFileSync(resolve(repoRoot, 'CLAUDE.md'), 'utf-8');
    // Pull Solana's chain override so we can verify the Solana
    // moonshot-cap parenthetical in CLAUDE.md.
    let chainOverrides = {};
    try {
      chainOverrides = { solana: getPortfolioRules('solana') };
    } catch {
      /* if chains.js can't load, fall back to defaults */
    }
    return findSafetyRuleMismatches(claudeMd, PORTFOLIO_RULES, chainOverrides);
  } catch (err) {
    return [{ rule: 'CLAUDE.md', reason: `read_failed: ${err.message}` }];
  }
}

// PR 3.1: MEMORY.md write-protection. New pattern entries (lines
// matching the H3 header) are only legitimate when accompanied by a
// `<!-- via promote-pattern.js ... -->` trail marker, which the
// promote-pattern.js script emits on every successful append.
//
// This catches manual / agent edits that bypass the validated path,
// since prompt-injected agents are most likely to just `cat >>
// MEMORY.md` rather than invoke the validating script.
//
// ============================================================
// PR 3.4: npm audit gate. When scripts/package-lock.json is in the
// staged diff, we run `npm audit --audit-level=high --json` and
// refuse the commit if any high/critical vulnerabilities exist that
// aren't on the explicit allowlist below.
//
// Why an allowlist? Because there ARE known transitive findings we
// can't realistically fix without breaking working code (e.g. the
// bigint-buffer chain via @solana/spl-token). We accept those
// explicitly. Any NEW finding outside the allowlist blocks.
//
// To extend: add the package name (the offender, not the parent
// that brought it in). Better: review whether you can actually fix.
// ============================================================

export const AUDIT_ALLOWLIST = [
  // bigint-buffer has a high-severity issue in a buffer-allocation
  // path. It's transitively required by @solana/spl-token (which the
  // executor needs for SPL balance reads) and @sqds/multisig (which
  // the executor needs to build Squads transactions). Neither has
  // published a fix in the lines we use. Tracked upstream — re-
  // evaluate on every spl-token / sqds bump.
  'bigint-buffer',
  '@solana/buffer-layout-utils',
  '@solana/spl-token',
  '@sqds/multisig',
];

/**
 * Pure predicate: given a parsed `npm audit --json` object, return
 * the list of vulnerability findings that are NOT on the allowlist.
 * Exported for unit testing.
 */
export function findUnacceptableVulns(auditJson, allowlist = AUDIT_ALLOWLIST) {
  if (!auditJson || typeof auditJson !== 'object') return [];
  const vulns = auditJson.vulnerabilities || {};
  const allowed = new Set(allowlist);
  const findings = [];
  for (const [pkg, info] of Object.entries(vulns)) {
    if (allowed.has(pkg)) continue;
    if (!info || typeof info !== 'object') continue;
    if (info.severity !== 'high' && info.severity !== 'critical') continue;
    findings.push({
      package: pkg,
      severity: info.severity,
      via: Array.isArray(info.via) ? info.via.map((v) => (typeof v === 'string' ? v : v?.name || '')) : [],
      fixAvailable: info.fixAvailable ? true : false,
    });
  }
  return findings;
}

function runNpmAudit() {
  try {
    const scriptsDir = resolve(__dirname);
    // npm audit returns exit 1 if vulns found — capture both paths.
    let raw;
    try {
      raw = execSync('npm audit --audit-level=high --json', { encoding: 'utf-8', cwd: scriptsDir });
    } catch (err) {
      // exit 1 with JSON on stdout is the "found vulns" path.
      raw = err.stdout || err.stderr || '';
    }
    return JSON.parse(raw);
  } catch (err) {
    return { error: err.message };
  }
}

// Exported for unit testing. State machine: a marker line sets
// `pendingMarker`; the very next pattern header CONSUMES it. Headers
// without a pending marker get flagged. This way, one marker can't
// vouch for multiple subsequent headers.
export function findMissingMemoryTrails(diff) {
  const findings = [];
  let currentFile = null;
  let lineNum = 0;
  let pendingMarker = false;

  for (const line of diff.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      pendingMarker = false;
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      lineNum = parseInt(hunkMatch[1], 10) - 1;
      pendingMarker = false;
      continue;
    }
    if (!currentFile || !currentFile.endsWith('MEMORY.md')) continue;
    if (line.startsWith('+++')) continue;
    if (!line.startsWith('+')) continue;

    lineNum++;
    const content = line.slice(1);

    // Marker lines just arm the "pending" flag. They don't count as
    // headers themselves.
    if (content.includes('<!-- via promote-pattern.js')) {
      pendingMarker = true;
      continue;
    }

    // We only care about ADDED H3 pattern headers ("### Foo …").
    if (!/^### \S/.test(content)) continue;
    // Skip the well-known template H3 already in the file.
    if (/^### \[/.test(content) || content.includes('Template')) continue;

    if (!pendingMarker) {
      findings.push({
        file: currentFile,
        line: lineNum,
        rule: 'memory-pattern-without-trail',
        description: 'New MEMORY.md pattern header without a `<!-- via promote-pattern.js ... -->` marker',
        snippet: content.slice(0, 80),
      });
    }
    // Consume the marker — next header needs its own.
    pendingMarker = false;
  }
  return findings;
}

function main() {
  let diff;
  try {
    diff = execSync('git diff --cached -U0 --diff-filter=ACM', { encoding: 'utf-8' });
  } catch {
    // No staged files or git error — pass through
    process.exit(0);
  }

  if (!diff.trim()) {
    process.exit(0);
  }

  const findings = [];
  let currentFile = null;
  let lineNum = 0;

  for (const line of diff.split('\n')) {
    // Track current file
    const fileMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }

    // Track line numbers from hunk headers
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      lineNum = parseInt(hunkMatch[1], 10) - 1;
      continue;
    }

    // Only check added lines
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    lineNum++;

    const content = line.slice(1); // Remove leading '+'

    if (isAllowlisted(content, currentFile)) continue;

    for (const { name, pattern, description } of PATTERNS) {
      const match = content.match(pattern);
      if (!match) continue;

      // Extra check for hex keys — skip obviously fake ones
      if (name === 'hex-private-key' && isFakeHexKey(match[0])) continue;

      findings.push({
        file: currentFile,
        line: lineNum,
        rule: name,
        description,
        snippet: content.trim().slice(0, 80),
      });
    }
  }

  // PR 3.1: also scan for MEMORY.md edits without the trail marker.
  // We need full -U context for the look-back to work; re-fetch.
  let memoryFindings = [];
  try {
    const fullDiff = execSync('git diff --cached --diff-filter=ACM', { encoding: 'utf-8' });
    memoryFindings = findMissingMemoryTrails(fullDiff);
  } catch {
    /* skip if git fails */
  }

  // PR 3.4: npm audit gate. Only fires when scripts/package-lock.json
  // is in the staged diff (avoids the per-commit npm-audit cost on
  // unrelated changes).
  let auditFindings = [];
  const auditAllowedNoted = [];
  try {
    const stagedFiles = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf-8' });
    if (stagedFiles.split('\n').some((f) => f === 'scripts/package-lock.json')) {
      const audit = runNpmAudit();
      if (audit.error) {
        console.error(`⚠️  npm audit failed to run: ${audit.error}`);
      } else {
        auditFindings = findUnacceptableVulns(audit);
        // List allowed-but-present findings as info so the operator
        // sees what's still "accepted".
        const allowed = new Set(AUDIT_ALLOWLIST);
        const vulns = audit.vulnerabilities || {};
        for (const [pkg, info] of Object.entries(vulns)) {
          if (allowed.has(pkg) && (info.severity === 'high' || info.severity === 'critical')) {
            auditAllowedNoted.push({ package: pkg, severity: info.severity });
          }
        }
      }
    }
  } catch {
    /* skip if git fails */
  }

  // PR 4.4: CLAUDE.md ↔ chains.js drift gate. Runs on every commit
  // (cheap — single file read + import). Only fires findings when
  // CLAUDE.md OR chains.js is in the staged diff (avoids re-flagging
  // pre-existing drift on commits that don't touch either).
  let safetyRuleFindings = [];
  try {
    const stagedFiles = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf-8' });
    const staged = stagedFiles.split('\n');
    if (staged.includes('CLAUDE.md') || staged.includes('scripts/chains.js')) {
      safetyRuleFindings = runSafetyRuleGate();
    }
  } catch {
    /* skip if git fails */
  }

  if (
    findings.length === 0 &&
    memoryFindings.length === 0 &&
    auditFindings.length === 0 &&
    safetyRuleFindings.length === 0
  ) {
    if (auditAllowedNoted.length > 0) {
      console.error('ℹ️  npm audit: allowlisted vulnerabilities still present (no-op):');
      for (const v of auditAllowedNoted) console.error(`     ${v.package} (${v.severity})`);
    }
    process.exit(0);
  }

  if (findings.length > 0) {
    console.error('🚨 Pre-commit secret scan found potential secrets:');
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}`);
      console.error(`    Rule: ${f.rule} — ${f.description}`);
      console.error(`    Line: ${f.snippet}`);
      console.error('');
    }
    console.error('To suppress a false positive, add "// pre-commit-allow" to the line.');
    console.error('');
  }

  if (memoryFindings.length > 0) {
    console.error('🚨 MEMORY.md edit without provenance marker (PR 3.1):');
    for (const f of memoryFindings) {
      console.error(`  ${f.file}:${f.line}`);
      console.error(`    Rule: ${f.rule}`);
      console.error(`    Header: ${f.snippet}`);
      console.error('');
    }
    console.error('Use scripts/promote-pattern.js to add patterns. It validates');
    console.error('inputs and emits the required `<!-- via promote-pattern.js ... -->`');
    console.error('marker. Manual edits are rejected to defang memory poisoning.');
    console.error('');
  }

  if (auditFindings.length > 0) {
    console.error('🚨 npm audit found unacceptable vulnerabilities (PR 3.4):');
    for (const f of auditFindings) {
      console.error(`  ${f.package} (${f.severity})${f.fixAvailable ? ' — fix available' : ''}`);
      if (f.via.length > 0) console.error(`    via: ${f.via.join(' → ')}`);
    }
    console.error('');
    console.error('Run `npm audit` in scripts/ for details. To accept a finding,');
    console.error('add the package name to AUDIT_ALLOWLIST in pre-commit-check.js');
    console.error('with a comment explaining why.');
    console.error('');
  }

  if (safetyRuleFindings.length > 0) {
    console.error('🚨 CLAUDE.md ↔ chains.js safety-rule drift (PR 4.4):');
    for (const f of safetyRuleFindings) {
      if (f.reason === 'value_mismatch') {
        console.error(`  ${f.phrase}: CLAUDE.md says ${f.mdValue}%, chains.js enforces ${f.jsValue}%`);
      } else if (f.reason === 'solana_override_mismatch') {
        console.error(`  ${f.phrase} (Solana): CLAUDE.md says ${f.mdValue}%, chains.js enforces ${f.jsValue}%`);
      } else if (f.reason === 'phrase_missing_in_claude_md') {
        console.error(`  ${f.phrase}: missing from CLAUDE.md (chains.js value: ${f.jsValue}%)`);
      } else {
        console.error(`  ${f.rule}: ${f.reason}`);
      }
    }
    console.error('');
    console.error('Update either CLAUDE.md or scripts/chains.js so they agree.');
    console.error('chains.js is the runtime source of truth; CLAUDE.md is the');
    console.error('agent-facing summary. They MUST stay in sync — agent prose that');
    console.error('disagrees with the executor breaks the trust contract.');
    console.error('');
  }

  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
