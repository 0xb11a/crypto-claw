// ADR-0026 ESLint rule smoke test
//
// Verifies that the no-restricted-syntax rule for bare-key
// configService.get with an empty string key fires when present in
// production source code, and does NOT fire in test files.
//
// Plan section B.5 / D:
//   - Rule fires on apps/*.ts and libs/*.ts
//   - Rule does NOT fire on *.spec.ts files (test block has no-restricted-syntax: off)
//
// DoD A -- new ESLint rule covered by a test that fails on violation.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const ESLINT_BIN = resolve(REPO_ROOT, 'node_modules/.bin/eslint');

function runEslintWithConfig(filePath: string): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(ESLINT_BIN, ['--no-ignore', filePath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PRISMA_DISABLE_DOTENV: '1',
    },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('ADR-0026 -- ESLint no-restricted-syntax rule for bare-key configService.get', () => {
  // Fixture file name with timestamp to avoid collisions across parallel runs.
  const fixtureName = '_adr0026-fixture-' + Date.now().toString() + '.ts';
  const fixturePath = resolve(REPO_ROOT, 'apps/worker/src', fixtureName);

  // Write the violating fixture before tests run.
  // The content uses configService.get with an empty string key which is the
  // exact pattern ADR-0026 bans (selector in eslint.config.js:
  //   CallExpression[callee.property.name='get'][arguments.0.type='Literal'][arguments.0.value='']
  const violatingContent = [
    '// ADR-0026 test fixture written by adr-0026-eslint-rule.spec.ts',
    "import { Injectable } from '@nestjs/common';",
    "import { ConfigService } from '@nestjs/config';",
    '@Injectable()',
    'export class BadService {',
    '  constructor(private readonly cs: ConfigService) {}',
    '  bad() {',
    "    // This pattern is banned by ADR-0026: get('') bare-key access",
    "    return this.cs.get('');",
    '  }',
    '}',
  ].join('\n');

  try {
    writeFileSync(fixturePath, violatingContent, 'utf8');
  } catch {
    // Read-only CI env — tests below will still run but may behave differently
  }

  it('ESLint binary is reachable', () => {
    const result = spawnSync(ESLINT_BIN, ['--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
  });

  it('rule fires when bare-key configService.get with empty string is present in apps src', () => {
    const result = runEslintWithConfig(fixturePath);
    // ESLint exits 1 when there are lint errors
    expect(result.exitCode).toBe(1);
    // The output must reference the ADR-0026 rule violation
    const output = result.stdout + result.stderr;
    // no-restricted-syntax reports the selector message, which includes ADR-0026
    expect(output).toMatch(/ADR-0026|Bare-key|no-restricted-syntax/i);

    // Cleanup after assertion
    try {
      rmSync(fixturePath);
    } catch {
      /* ignore */
    }
  });

  it('rule does NOT fire on spec files (no-restricted-syntax is off in test block)', () => {
    // Write a violating pattern into a spec file -- the test block in eslint.config.js
    // has no-restricted-syntax: off, so it must NOT produce the ADR-0026 error.
    const specFixtureName = '_adr0026-specfix-' + Date.now().toString() + '.spec.ts';
    const specFixturePath = resolve(REPO_ROOT, 'apps/worker/src', specFixtureName);

    const specContent = [
      '// spec-file fixture',
      "import { Injectable } from '@nestjs/common';",
      "import { ConfigService } from '@nestjs/config';",
      'function ok(cs: ConfigService) {',
      "  return cs.get('');",
      '}',
      'export { ok };',
    ].join('\n');

    try {
      writeFileSync(specFixturePath, specContent, 'utf8');
      const result = runEslintWithConfig(specFixturePath);
      // The output must NOT contain the ADR-0026 bare-key error
      const output = result.stdout + result.stderr;
      const hasBareKeyError = /ADR-0026|Bare-key.*configService/i.test(output);
      expect(hasBareKeyError).toBe(false);
    } finally {
      try {
        rmSync(specFixturePath);
      } catch {
        /* ignore */
      }
    }
  });
});
