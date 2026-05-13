/**
 * Unit tests for spawn-executor.ts
 *
 * Tests the filterParentEnv() function (signer-key stripping).
 * spawnExecutor() itself is tested in integration/E2E specs.
 *
 * SECURITY NOTE: these tests assert the signer-isolation invariant at
 * the unit level. The E2E test (`tests/e2e/signer-isolation.spec.ts`)
 * verifies the full spawn lifecycle.
 */
import { describe, it, expect } from 'vitest';
import { filterParentEnv } from './spawn-executor.js';

describe('filterParentEnv()', () => {
  it('strips SAFE_SIGNER_KEY', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      SAFE_SIGNER_KEY: 'should-be-stripped',
      PATH: '/usr/bin',
    };
    const filtered = filterParentEnv(env);
    expect('SAFE_SIGNER_KEY' in filtered).toBe(false);
    expect(filtered['NODE_ENV']).toBe('test');
    expect(filtered['PATH']).toBe('/usr/bin');
  });

  it('strips SQUADS_SIGNER_KEY', () => {
    const env: NodeJS.ProcessEnv = {
      SQUADS_SIGNER_KEY: 'also-stripped',
      REDIS_URL: 'redis://localhost:6379',
    };
    const filtered = filterParentEnv(env);
    expect('SQUADS_SIGNER_KEY' in filtered).toBe(false);
    expect(filtered['REDIS_URL']).toBe('redis://localhost:6379');
  });

  it('strips any var ending in SIGNER_KEY', () => {
    const env: NodeJS.ProcessEnv = {
      CUSTOM_SIGNER_KEY: 'also-stripped',
      OTHER_VAR: 'kept',
    };
    const filtered = filterParentEnv(env);
    expect('CUSTOM_SIGNER_KEY' in filtered).toBe(false);
    expect(filtered['OTHER_VAR']).toBe('kept');
  });

  it('does NOT strip vars that contain SIGNER_KEY but do not END with it', () => {
    const env: NodeJS.ProcessEnv = {
      SIGNER_KEY_FILE: 'kept-because-not-suffix',
      OTHER_VAR: 'kept',
    };
    const filtered = filterParentEnv(env);
    expect(filtered['SIGNER_KEY_FILE']).toBe('kept-because-not-suffix');
  });

  it('skips undefined values', () => {
    const env: NodeJS.ProcessEnv = {
      DEFINED: 'value',
      UNDEFINED: undefined,
    };
    const filtered = filterParentEnv(env);
    expect(filtered['DEFINED']).toBe('value');
    expect('UNDEFINED' in filtered).toBe(false);
  });

  it('does not mutate the original env object', () => {
    const env: NodeJS.ProcessEnv = {
      SAFE_SIGNER_KEY: 'original',
      OTHER: 'value',
    };
    const copy = { ...env };
    filterParentEnv(env);
    // Original must be unchanged
    expect(env['SAFE_SIGNER_KEY']).toBe('original');
    expect(env).toEqual(copy);
  });

  it('returns a plain object (not the same reference as input)', () => {
    const env: NodeJS.ProcessEnv = { A: 'a' };
    const filtered = filterParentEnv(env);
    expect(filtered).not.toBe(env);
  });

  it('handles empty env', () => {
    const filtered = filterParentEnv({});
    expect(Object.keys(filtered)).toHaveLength(0);
  });
});
