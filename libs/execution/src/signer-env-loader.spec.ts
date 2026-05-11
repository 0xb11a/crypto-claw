/**
 * Unit tests for signer-env-loader.ts
 *
 * Tests file parsing, mode checking, and error behavior.
 * Does NOT use the literal signer sentinel value — uses unique test values.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSignerEnv } from './signer-env-loader.js';

const TMP = tmpdir();

function makeTempFile(contents: string, suffix = '.env'): string {
  const path = join(TMP, `cclaw-test-${Date.now()}${suffix}`);
  writeFileSync(path, contents, { mode: 0o400 });
  return path;
}

let tempFiles: string[] = [];

beforeEach(() => {
  tempFiles = [];
});

afterEach(() => {
  for (const f of tempFiles) {
    try {
      chmodSync(f, 0o600);
      unlinkSync(f);
    } catch {
      // ignore cleanup errors
    }
  }
});

describe('loadSignerEnv()', () => {
  it('parses KEY=value pairs', () => {
    const path = makeTempFile(
      ['# comment line', '', 'SAFE_SIGNER_KEY=aabbccddeeff112233', 'SQUADS_SIGNER_KEY=xyzBase58Key'].join('\n'),
    );
    tempFiles.push(path);

    const result = loadSignerEnv(path, 'test');
    expect(result.SAFE_SIGNER_KEY).toBe('aabbccddeeff112233');
    expect(result.SQUADS_SIGNER_KEY).toBe('xyzBase58Key');
  });

  it('returns empty strings for missing keys', () => {
    const path = makeTempFile('# empty file\n');
    tempFiles.push(path);

    const result = loadSignerEnv(path, 'test');
    expect(result.SAFE_SIGNER_KEY).toBe('');
    expect(result.SQUADS_SIGNER_KEY).toBe('');
  });

  it('strips surrounding double quotes from values', () => {
    const path = makeTempFile('SAFE_SIGNER_KEY="quoted-value"\n'); // pre-commit-allow
    tempFiles.push(path);

    const result = loadSignerEnv(path, 'test');
    expect(result.SAFE_SIGNER_KEY).toBe('quoted-value');
  });

  it('strips surrounding single quotes from values', () => {
    const path = makeTempFile("SAFE_SIGNER_KEY='single-quoted'\n"); // pre-commit-allow
    tempFiles.push(path);

    const result = loadSignerEnv(path, 'test');
    expect(result.SAFE_SIGNER_KEY).toBe('single-quoted');
  });

  it('throws if file does not exist', () => {
    expect(() => loadSignerEnv('/nonexistent/path/signer.env', 'test')).toThrow('[signer-env-loader] cannot stat');
  });

  it('throws in production mode if file is world-readable (0644)', () => {
    const path = makeTempFile('SAFE_SIGNER_KEY=test\n');
    tempFiles.push(path);
    chmodSync(path, 0o644); // world-readable — insecure

    expect(() => loadSignerEnv(path, 'production')).toThrow('[signer-env-loader]');
  });

  it('does not throw in development mode if file is world-readable (warns only)', () => {
    const path = makeTempFile('SAFE_SIGNER_KEY=test-dev-value\n');
    tempFiles.push(path);
    chmodSync(path, 0o644); // insecure mode — only warns in dev

    // Should NOT throw in development mode
    expect(() => loadSignerEnv(path, 'development')).not.toThrow();
    const result = loadSignerEnv(path, 'development');
    expect(result.SAFE_SIGNER_KEY).toBe('test-dev-value');
  });

  it('accepts mode 0600 in production', () => {
    const path = makeTempFile('SAFE_SIGNER_KEY=prod-value\n');
    tempFiles.push(path);
    chmodSync(path, 0o600);

    const result = loadSignerEnv(path, 'production');
    expect(result.SAFE_SIGNER_KEY).toBe('prod-value');
  });

  it('accepts mode 0400 in production', () => {
    const path = makeTempFile('SAFE_SIGNER_KEY=readonly-value\n');
    tempFiles.push(path);
    // File was created with 0400 — no chmod needed

    const result = loadSignerEnv(path, 'production');
    expect(result.SAFE_SIGNER_KEY).toBe('readonly-value');
  });

  it('handles keys with = signs in values', () => {
    const path = makeTempFile('SAFE_SIGNER_KEY=abc=def=ghi\n');
    tempFiles.push(path);

    const result = loadSignerEnv(path, 'test');
    // Only first = is the delimiter; rest is part of value
    expect(result.SAFE_SIGNER_KEY).toBe('abc=def=ghi');
  });
});
