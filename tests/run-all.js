#!/usr/bin/env node
/**
 * Run All Tests
 *
 * Executes all test suites in order:
 * 1. Memory (state files exist and have correct schema)
 * 2. Safety (hard-coded rules work correctly)
 * 3. Pipeline (stages connect properly)
 * 4. Executor (validation, receipts, slippage, portfolio updates)
 * 5. Paper Mode (paper trading lifecycle, P&L, stats)
 * 6. Scripts (data fetchers work — requires network, run separately)
 */

import { execSync } from 'child_process';
import { resolve } from 'path';

const TESTS_DIR = new URL('.', import.meta.url).pathname;

const suites = [
  { name: 'Memory System', file: 'test-memory.js', requiresNetwork: false },
  { name: 'Safety Rules', file: 'test-safety.js', requiresNetwork: false },
  { name: 'Pipeline Integration', file: 'test-pipeline.js', requiresNetwork: false },
  { name: 'Executor Agent', file: 'test-executor.js', requiresNetwork: false },
  { name: 'Paper Mode', file: 'test-paper-mode.js', requiresNetwork: false },
  { name: 'E2E Paper Mode', file: 'test-e2e-paper.js', requiresNetwork: false },
];

// Scripts tests require network — run separately
const networkSuites = [
  { name: 'Scripts (network)', file: 'test-scripts.js', requiresNetwork: true },
];

const skipNetwork = process.argv.includes('--offline');
const allSuites = skipNetwork ? suites : [...suites, ...networkSuites];

console.log('🦞 CryptoClaw Test Runner\n');
console.log(`Running ${allSuites.length} test suite(s)${skipNetwork ? ' (offline mode)' : ''}...\n`);

let totalPassed = 0;
let totalFailed = 0;

for (const suite of allSuites) {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`🧪 ${suite.name}`);
  console.log('━'.repeat(60));

  try {
    const output = execSync(`node ${resolve(TESTS_DIR, suite.file)}`, {
      encoding: 'utf-8',
      timeout: 60_000,
      cwd: resolve(TESTS_DIR, '..'),
    });
    console.log(output);
    totalPassed++;
  } catch (err) {
    console.log(err.stdout || '');
    console.log(err.stderr || '');
    totalFailed++;
  }
}

console.log(`\n${'━'.repeat(60)}`);
console.log(`\n🦞 Final Results: ${totalPassed} suites passed, ${totalFailed} failed`);

if (skipNetwork) {
  console.log('\n💡 Run without --offline to include network-dependent script tests');
}

console.log('━'.repeat(60));
process.exit(totalFailed > 0 ? 1 : 0);
