#!/usr/bin/env node
/**
 * pre-commit-check.js — Secret scanner for pre-commit hook
 *
 * Reads staged diff and checks added lines for accidental secrets.
 * Exit 0 = clean, Exit 1 = secrets found.
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

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
  // Binary test fixtures (Borsh/Solana account dumps, signed binaries) can
  // resemble base58 private-key patterns by construction. Inline allow-comments
  // can't be added to raw .b64 / .bin payloads. Scope the allowlist to
  // __fixtures__/ subtrees, which are vendored test data only.
  if (/(?:^|\/)__fixtures__\//.test(file)) return true;
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
// P5: CLAUDE.md ↔ chains.js safety-rule drift gate REMOVED.
//
// chains.js was deleted in P5. The canonical portfolio rules now live
// in libs/chain/src/portfolio-rules.ts (TypeScript, validated by the
// TypeScript compiler and ESLint). The LLM-facing prose in CLAUDE.md
// is audited via the /audit-instructions skill (Pass 3). Pre-commit
// enforcement of the CLAUDE.md prose match is deferred to a future
// P5b ADR when a TS-based gate can read portfolio-rules.ts directly.
// ============================================================

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

  if (findings.length === 0 && memoryFindings.length === 0 && auditFindings.length === 0) {
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

  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
