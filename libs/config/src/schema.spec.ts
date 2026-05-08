import { describe, it, expect } from 'vitest';
import { parseEnv } from './schema.js';
import { assertNoSignerKeysInEnv, assertConfigValid } from './boot-checks.js';

/**
 * Minimal valid env object satisfying all required fields.
 * Uses 32-char dummy values for API keys to satisfy minimum-length check.
 */
const VALID_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'test-fund',
  REDIS_URL: 'redis://localhost:6379',
  RESEARCH_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
  SENTINEL_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2',
  EXECUTOR_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3',
  OBSERVER_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4',
  LOOP_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5',
  WORKER_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6',
  SCHEDULER_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7',
  DASHBOARD_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa8',
  ACTIVE_CHAINS: 'base,solana',
  OPENAI_API_KEY: 'ci-dummy',
};

describe('parseEnv — happy path', () => {
  it('returns typed config when all required fields are present', () => {
    const config = parseEnv(VALID_ENV);
    expect(config.SAFE_ID).toBe('test-fund');
    expect(config.REDIS_URL).toBe('redis://localhost:6379');
    expect(config.ACTIVE_CHAINS).toBe('base,solana');
  });

  it('derives DB_PATH from SAFE_ID when not explicitly set', () => {
    const config = parseEnv(VALID_ENV);
    expect(config.DB_PATH).toBe('./data/test-fund.db');
  });

  it('uses explicit DB_PATH when provided', () => {
    const config = parseEnv({ ...VALID_ENV, DB_PATH: '/mnt/data/custom.db' });
    expect(config.DB_PATH).toBe('/mnt/data/custom.db');
  });

  it('defaults PAPER_MODE to false', () => {
    const config = parseEnv(VALID_ENV);
    expect(config.PAPER_MODE).toBe(false);
  });

  it('parses PAPER_MODE=true correctly', () => {
    const config = parseEnv({ ...VALID_ENV, PAPER_MODE: 'true' });
    expect(config.PAPER_MODE).toBe(true);
  });

  it('defaults PAPER_STARTING_BALANCE to 10000', () => {
    const config = parseEnv(VALID_ENV);
    expect(config.PAPER_STARTING_BALANCE).toBe(10000);
  });

  it('parses custom PAPER_STARTING_BALANCE', () => {
    const config = parseEnv({ ...VALID_ENV, PAPER_STARTING_BALANCE: '5000' });
    expect(config.PAPER_STARTING_BALANCE).toBe(5000);
  });

  it('defaults AUTO_APPROVE_BUY to false', () => {
    const config = parseEnv(VALID_ENV);
    expect(config.AUTO_APPROVE_BUY).toBe(false);
  });
});

describe('parseEnv — missing required fields', () => {
  it('throws with [config] invalid env: prefix when SAFE_ID missing', () => {
    const env = { ...VALID_ENV };
    delete env.SAFE_ID;
    expect(() => parseEnv(env)).toThrow(/^\[config\] invalid env: SAFE_ID/);
  });

  it('throws with [config] invalid env: prefix when REDIS_URL missing', () => {
    const env = { ...VALID_ENV };
    delete env.REDIS_URL;
    expect(() => parseEnv(env)).toThrow(/^\[config\] invalid env: REDIS_URL/);
  });

  it('throws with [config] invalid env: prefix when RESEARCH_API_KEY too short', () => {
    expect(() => parseEnv({ ...VALID_ENV, RESEARCH_API_KEY: 'short' })).toThrow(
      /^\[config\] invalid env: RESEARCH_API_KEY/,
    );
  });

  it('throws with [config] invalid env: prefix when ACTIVE_CHAINS missing', () => {
    const env = { ...VALID_ENV };
    delete env.ACTIVE_CHAINS;
    expect(() => parseEnv(env)).toThrow(/^\[config\] invalid env: ACTIVE_CHAINS/);
  });

  it('throws with [config] invalid env: prefix when REDIS_URL is not a URL', () => {
    expect(() => parseEnv({ ...VALID_ENV, REDIS_URL: 'not-a-url' })).toThrow(
      /^\[config\] invalid env: REDIS_URL/,
    );
  });
});

describe('assertNoSignerKeysInEnv', () => {
  it('does not throw when signer keys are absent', () => {
    expect(() => assertNoSignerKeysInEnv(VALID_ENV)).not.toThrow();
  });

  it('throws when SAFE_SIGNER_KEY is set', () => {
    expect(() =>
      assertNoSignerKeysInEnv({ ...VALID_ENV, SAFE_SIGNER_KEY: 'deadbeef' }),
    ).toThrow('[boot] signer keys must not be present in this process env (got: SAFE_SIGNER_KEY)');
  });

  it('throws when SQUADS_SIGNER_KEY is set', () => {
    expect(() =>
      assertNoSignerKeysInEnv({ ...VALID_ENV, SQUADS_SIGNER_KEY: 'deadbeef' }),
    ).toThrow(
      '[boot] signer keys must not be present in this process env (got: SQUADS_SIGNER_KEY)',
    );
  });

  it('does not throw when signer keys are empty strings', () => {
    // Docker compose topology explicitly blanks these: SAFE_SIGNER_KEY=
    expect(() =>
      assertNoSignerKeysInEnv({ ...VALID_ENV, SAFE_SIGNER_KEY: '', SQUADS_SIGNER_KEY: '' }),
    ).not.toThrow();
  });
});

describe('assertConfigValid', () => {
  it('returns typed config for a valid env', () => {
    const config = assertConfigValid(VALID_ENV);
    expect(config.SAFE_ID).toBe('test-fund');
  });
});
