#!/usr/bin/env node
// check-worker-scheduler-no-http.mjs
//
// CI guard: apps/worker and apps/scheduler must NOT import HTTP client libraries.
//
// WORKER and SCHEDULER have empty identity scope sets in IDENTITY_SCOPES (ADR-0009
// addendum, ADR-0029). Their tokens 403 on every route in enforce mode. If a future
// PR adds an outbound HTTP call from apps/worker or apps/scheduler to apps/api, the
// resulting 403 is the signal that the scope set needs an explicit entry — NOT that
// the boundary should be silently widened.
//
// This guard intercepts that situation at the CI level before it reaches production.
//
// Checked patterns (imports AND usage):
//   import statements: node-fetch, axios, undici, got, http, https, http2
//   usage calls: fetch(...), axios(...), axios.get/post/..., undici(...), got(...)
//
// Exits 0 on success; exits 1 with a descriptive error if any HTTP import is found.
//
// Usage:
//   node scripts/ci/check-worker-scheduler-no-http.mjs
//
// DoD §F — security changes (WORKER/SCHEDULER empty-scope invariant).
// DoD §G — CI gate.
// P7 PR-C1, auditor suggestion #8.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

// Directories to scan (src only — dist is generated)
const SCAN_DIRS = [join(REPO_ROOT, 'apps', 'worker', 'src'), join(REPO_ROOT, 'apps', 'scheduler', 'src')];

/**
 * Patterns that indicate an HTTP client is being imported or used.
 *
 * Import patterns: match `from 'node-fetch'`, `from "axios"`, `import 'undici'`, etc.
 * Usage patterns: match `fetch(`, `axios(`, `axios.get(`, `undici(`, `got(`
 *
 * Note: `fetch` without qualification is checked against a stricter pattern that
 * excludes internal `this.fetch` or `mockFetch` patterns — bare `fetch(` on its own
 * line is the concern, not method calls on objects.
 */
const FORBIDDEN_IMPORT_PATTERNS = [
  // ESM / CommonJS import of HTTP client libraries
  /from\s*['"](?:node-fetch|axios|undici|got|http|https|http2)['"]/,
  /require\s*\(\s*['"](?:node-fetch|axios|undici|got|http|https|http2)['"]\s*\)/,
  /import\s*['"](?:node-fetch|axios|undici|got)['"]/,
];

const FORBIDDEN_USAGE_PATTERNS = [
  // Bare fetch() call (not a method call on an object)
  /(?:^|[^.\w])fetch\s*\(/,
  // axios usage
  /\baxios\s*\(/,
  /\baxios\.(get|post|put|patch|delete|head|request)\s*\(/,
  // undici usage
  /\bundici\s*\(/,
  /\bgot\s*\(/,
];

/**
 * Scan a single TypeScript file for forbidden HTTP patterns.
 * Returns an array of { line, lineNumber, pattern } objects for violations.
 */
function scanFile(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comments — lines that start with // or * (JSDoc)
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // Check import patterns
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({ file: filePath, lineNum, line: line.trim(), pattern: pattern.toString() });
        break; // one violation per line per category
      }
    }

    // Check usage patterns
    for (const pattern of FORBIDDEN_USAGE_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({ file: filePath, lineNum, line: line.trim(), pattern: pattern.toString() });
        break;
      }
    }
  }

  return violations;
}

/**
 * Recursively find all *.ts files (excluding *.spec.ts and *.test.ts) under a directory.
 */
function findTypeScriptFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results; // directory may not exist
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
      results.push(...findTypeScriptFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const allFiles = SCAN_DIRS.flatMap((dir) => findTypeScriptFiles(dir));

if (allFiles.length === 0) {
  // Directories may not exist in all environments — treat as OK.
  console.log('[check-worker-scheduler-no-http] OK — no apps/worker or apps/scheduler src files found (skip)');
  process.exit(0);
}

const allViolations = allFiles.flatMap((f) => scanFile(f));

if (allViolations.length > 0) {
  const relRoot = REPO_ROOT + '/';
  console.error(
    '[check-worker-scheduler-no-http] ERROR: HTTP client imports/usage found in apps/worker or apps/scheduler.\n' +
      'WORKER and SCHEDULER have empty identity scope sets (ADR-0009 addendum, ADR-0029).\n' +
      'Presenting their tokens returns 403 on every route in enforce mode.\n' +
      'If you need outbound HTTP from worker/scheduler, add an explicit entry to IDENTITY_SCOPES\n' +
      'and have the change reviewed by the security-auditor before merging.\n\n' +
      'Violations:\n' +
      allViolations.map((v) => `  ${v.file.replace(relRoot, '')}:${v.lineNum}  ${v.line}`).join('\n'),
  );
  process.exit(1);
}

console.log(
  `[check-worker-scheduler-no-http] OK — no HTTP client imports in apps/worker or apps/scheduler (${allFiles.length} file(s) checked)`,
);
process.exit(0);
