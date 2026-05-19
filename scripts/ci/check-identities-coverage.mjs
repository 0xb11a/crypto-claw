#!/usr/bin/env node
// check-identities-coverage.mjs
//
// CI backstop: every controller handler that has @Roles must also have @Identities.
//
// This script greps controller source files for handler methods that carry
// @Get/@Post/@Put/@Patch/@Delete/@All but do NOT have a paired @Identities(...)
// on the same method definition.
//
// Exits 0 on success; exits 1 with a descriptive error if any handler is missing
// @Identities.
//
// Usage:
//   node scripts/ci/check-identities-coverage.mjs
//
// DoD §F — security changes; DoD §G — CI gate.
// P7 — per-identity authz tightening (ADR-0029).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

// Controller directories to scan
const SCAN_DIRS = [
  join(REPO_ROOT, 'libs', 'modules'),
  join(REPO_ROOT, 'libs', 'audit', 'src'),
  join(REPO_ROOT, 'libs', 'health', 'src'),
  join(REPO_ROOT, 'apps'),
];

const HTTP_DECORATORS = new Set(['@Get', '@Post', '@Put', '@Patch', '@Delete', '@All', '@Head', '@Options']);

/**
 * Parse a controller TypeScript source and find method definitions that have
 * an HTTP decorator but no @Identities decorator.
 *
 * Uses a simple line-by-line heuristic: scan lines in blocks between
 * "  @Get(...)" (or similar) and the actual method signature. A block is
 * considered "open" when we see an HTTP decorator, and "closed" when we hit
 * a line that looks like a method signature (has `(...)`).
 *
 * Returns an array of { line, decorator } objects for violations.
 */
function findMissingIdentities(src, filePath) {
  const lines = src.split('\n');
  const violations = [];

  let inHandlerBlock = false;
  let httpDecoratorLine = -1;
  let httpDecoratorName = '';
  let blockDecorators = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect HTTP decorator start
    const isHttpDecorator = [...HTTP_DECORATORS].some((d) => trimmed.startsWith(d));
    if (isHttpDecorator) {
      inHandlerBlock = true;
      httpDecoratorLine = i + 1; // 1-indexed
      httpDecoratorName = trimmed.split('(')[0];
      blockDecorators = [trimmed];
      continue;
    }

    if (inHandlerBlock) {
      // Collect other decorators in the block
      if (trimmed.startsWith('@')) {
        blockDecorators.push(trimmed);
      }

      // Method signature line: contains "(" and is not a decorator
      // and is not a multi-line decorator continuation (not starting with "@")
      const isMethodSignature =
        !trimmed.startsWith('@') &&
        (trimmed.includes('(') || trimmed.includes(')')) &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('*');

      if (isMethodSignature) {
        // Check if block has @Identities
        const hasIdentities = blockDecorators.some((d) => d.startsWith('@Identities'));
        if (!hasIdentities) {
          violations.push({
            file: filePath,
            line: httpDecoratorLine,
            handler: httpDecoratorName,
            methodLine: i + 1,
          });
        }
        inHandlerBlock = false;
        blockDecorators = [];
      }
    }
  }

  return violations;
}

/**
 * Recursively find all *.controller.ts files under a directory.
 */
function findControllers(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results; // directory may not exist in all envs
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
      results.push(...findControllers(full));
    } else if (entry.endsWith('.controller.ts') && !entry.endsWith('.spec.ts')) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const allControllers = SCAN_DIRS.flatMap((dir) => findControllers(dir));
const allViolations = [];

for (const ctrlPath of allControllers) {
  const src = readFileSync(ctrlPath, 'utf8');
  const violations = findMissingIdentities(src, ctrlPath);
  allViolations.push(...violations);
}

if (allViolations.length > 0) {
  const relRoot = REPO_ROOT + '/';
  console.error(
    '[check-identities-coverage] ERROR: The following handlers are missing @Identities(...) decorator:\n' +
      allViolations.map((v) => `  ${v.file.replace(relRoot, '')}:${v.line} ${v.handler}`).join('\n') +
      '\n\nAdd @Identities(...) to each handler per P7 requirements (ADR-0029).',
  );
  process.exit(1);
}

console.log(
  `[check-identities-coverage] OK — all ${allControllers.length} controller(s) have @Identities on every handler`,
);
process.exit(0);
