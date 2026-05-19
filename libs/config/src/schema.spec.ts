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

  // Executor subprocess config (P1c-i)
  it('defaults EXECUTOR_STUB_MODE to false', () => {
    const config = parseEnv(VALID_ENV);
    expect(config.EXECUTOR_STUB_MODE).toBe(false);
  });

  it('parses EXECUTOR_STUB_MODE=1 as true', () => {
    const config = parseEnv({ ...VALID_ENV, EXECUTOR_STUB_MODE: '1' });
    expect(config.EXECUTOR_STUB_MODE).toBe(true);
  });

  it('parses EXECUTOR_STUB_MODE=true as true', () => {
    const config = parseEnv({ ...VALID_ENV, EXECUTOR_STUB_MODE: 'true' });
    expect(config.EXECUTOR_STUB_MODE).toBe(true);
  });

  it('parses EXECUTOR_STUB_MODE=0 as false', () => {
    const config = parseEnv({ ...VALID_ENV, EXECUTOR_STUB_MODE: '0' });
    expect(config.EXECUTOR_STUB_MODE).toBe(false);
  });

  it('defaults SIGNER_ENV_FILE to /run/secrets/signer.env', () => {
    const config = parseEnv(VALID_ENV);
    expect(config.SIGNER_ENV_FILE).toBe('/run/secrets/signer.env');
  });

  it('accepts custom SIGNER_ENV_FILE path', () => {
    const config = parseEnv({ ...VALID_ENV, SIGNER_ENV_FILE: '/custom/path/signer.env' });
    expect(config.SIGNER_ENV_FILE).toBe('/custom/path/signer.env');
  });

  it('accepts EXECUTOR_BIN_PATH override', () => {
    const config = parseEnv({ ...VALID_ENV, EXECUTOR_BIN_PATH: '/app/dist/executor.js' });
    expect(config.EXECUTOR_BIN_PATH).toBe('/app/dist/executor.js');
  });

  it('EXECUTOR_BIN_PATH is undefined when not set', () => {
    const config = parseEnv(VALID_ENV);
    expect(config.EXECUTOR_BIN_PATH).toBeUndefined();
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
    expect(() => parseEnv({ ...VALID_ENV, REDIS_URL: 'not-a-url' })).toThrow(/^\[config\] invalid env: REDIS_URL/);
  });
});

describe('assertNoSignerKeysInEnv', () => {
  it('does not throw when signer keys are absent', () => {
    expect(() => assertNoSignerKeysInEnv(VALID_ENV)).not.toThrow();
  });

  it('throws when SAFE_SIGNER_KEY is set', () => {
    expect(() => assertNoSignerKeysInEnv({ ...VALID_ENV, SAFE_SIGNER_KEY: 'deadbeef' })).toThrow(
      '[boot] signer keys must not be present in this process env (got: SAFE_SIGNER_KEY)',
    );
  });

  it('throws when SQUADS_SIGNER_KEY is set', () => {
    expect(() => assertNoSignerKeysInEnv({ ...VALID_ENV, SQUADS_SIGNER_KEY: 'deadbeef' })).toThrow(
      '[boot] signer keys must not be present in this process env (got: SQUADS_SIGNER_KEY)',
    );
  });

  it('does not throw when signer keys are empty strings', () => {
    // Docker compose topology explicitly blanks these: SAFE_SIGNER_KEY=
    expect(() => assertNoSignerKeysInEnv({ ...VALID_ENV, SAFE_SIGNER_KEY: '', SQUADS_SIGNER_KEY: '' })).not.toThrow();
  });
});

describe('assertConfigValid', () => {
  it('returns typed config for a valid env', () => {
    const config = assertConfigValid(VALID_ENV);
    expect(config.SAFE_ID).toBe('test-fund');
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge cases (coder-flagged, SPEC §4 #4 + §4 #6 + ADR-0010)
// ---------------------------------------------------------------------------

describe('parseEnv — adversarial: ACTIVE_CHAINS empty string', () => {
  it('throws config error when ACTIVE_CHAINS is an empty string', () => {
    // An empty string is set by some container runtimes (ACTIVE_CHAINS=) and
    // must be rejected identically to a missing field.
    expect(() => parseEnv({ ...VALID_ENV, ACTIVE_CHAINS: '' })).toThrow(/^\[config\] invalid env: ACTIVE_CHAINS/);
  });
});

describe('parseEnv — adversarial: PAPER_STARTING_BALANCE must be positive', () => {
  it('throws config error when PAPER_STARTING_BALANCE is 0', () => {
    expect(() => parseEnv({ ...VALID_ENV, PAPER_STARTING_BALANCE: '0' })).toThrow(
      /^\[config\] invalid env: PAPER_STARTING_BALANCE/,
    );
  });

  it('throws config error when PAPER_STARTING_BALANCE is negative', () => {
    expect(() => parseEnv({ ...VALID_ENV, PAPER_STARTING_BALANCE: '-100' })).toThrow(
      /^\[config\] invalid env: PAPER_STARTING_BALANCE/,
    );
  });

  it('throws config error when PAPER_STARTING_BALANCE is non-numeric', () => {
    expect(() => parseEnv({ ...VALID_ENV, PAPER_STARTING_BALANCE: 'not-a-number' })).toThrow(
      /^\[config\] invalid env: PAPER_STARTING_BALANCE/,
    );
  });
});

describe('parseEnv — literal SPEC error strings (SPEC §4 #6)', () => {
  it('produces the exact SPEC-prescribed string for SAFE_ID missing', () => {
    const env = { ...VALID_ENV };
    delete env.SAFE_ID;
    expect(() => parseEnv(env)).toThrow('[config] invalid env: SAFE_ID — Required');
  });

  it('produces the exact SPEC-prescribed string for REDIS_URL invalid', () => {
    expect(() => parseEnv({ ...VALID_ENV, REDIS_URL: 'not-a-url' })).toThrow(
      '[config] invalid env: REDIS_URL — must be a valid URL (e.g. redis://redis:6379)',
    );
  });
});

// ---------------------------------------------------------------------------
// LOG_LEVEL field (added for guardrail: no process.env in libs/logger)
// ---------------------------------------------------------------------------

describe('parseEnv — LOG_LEVEL', () => {
  it('defaults LOG_LEVEL to "info" when not set', () => {
    const config = parseEnv(VALID_ENV);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('accepts a valid LOG_LEVEL value (debug)', () => {
    const config = parseEnv({ ...VALID_ENV, LOG_LEVEL: 'debug' });
    expect(config.LOG_LEVEL).toBe('debug');
  });

  it('accepts all valid LOG_LEVEL enum values', () => {
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const) {
      const config = parseEnv({ ...VALID_ENV, LOG_LEVEL: level });
      expect(config.LOG_LEVEL).toBe(level);
    }
  });

  it('throws [config] invalid env: LOG_LEVEL for an invalid value', () => {
    expect(() => parseEnv({ ...VALID_ENV, LOG_LEVEL: 'invalid' })).toThrow(/^\[config\] invalid env: LOG_LEVEL/);
  });

  it('throws the exact SPEC boot-fail string for LOG_LEVEL invalid', () => {
    expect(() => parseEnv({ ...VALID_ENV, LOG_LEVEL: 'verbose' })).toThrow('[config] invalid env: LOG_LEVEL');
  });
});

// ---------------------------------------------------------------------------
// NODE_ENV field (added for guardrail: no process.env in libs/logger)
// ---------------------------------------------------------------------------

describe('parseEnv — NODE_ENV', () => {
  it('defaults NODE_ENV to "development" when not set', () => {
    const config = parseEnv(VALID_ENV);
    expect(config.NODE_ENV).toBe('development');
  });

  it('accepts NODE_ENV=production', () => {
    const config = parseEnv({ ...VALID_ENV, NODE_ENV: 'production' });
    expect(config.NODE_ENV).toBe('production');
  });

  it('accepts NODE_ENV=test', () => {
    const config = parseEnv({ ...VALID_ENV, NODE_ENV: 'test' });
    expect(config.NODE_ENV).toBe('test');
  });

  it('throws [config] invalid env: NODE_ENV for an invalid value', () => {
    expect(() => parseEnv({ ...VALID_ENV, NODE_ENV: 'staging' })).toThrow(/^\[config\] invalid env: NODE_ENV/);
  });

  it('throws the exact SPEC boot-fail string for NODE_ENV invalid', () => {
    expect(() => parseEnv({ ...VALID_ENV, NODE_ENV: 'staging' })).toThrow('[config] invalid env: NODE_ENV');
  });
});

describe('assertNoSignerKeysInEnv — adversarial: both keys set simultaneously', () => {
  it('throws on SAFE_SIGNER_KEY when both keys are set', () => {
    // The function iterates FORBIDDEN_SIGNER_KEYS in order and throws on the
    // first hit. Setting both simultaneously must still reject.
    expect(() =>
      assertNoSignerKeysInEnv({
        ...VALID_ENV,
        SAFE_SIGNER_KEY: 'key-one',
        SQUADS_SIGNER_KEY: 'key-two',
      }),
    ).toThrow('[boot] signer keys must not be present in this process env (got: SAFE_SIGNER_KEY)');
  });
});

// ---------------------------------------------------------------------------
// API_BIND_ADDRESS (P6 — compose multi-service topology, ADR-0006 addendum)
// ---------------------------------------------------------------------------

describe('parseEnv — API_BIND_ADDRESS', () => {
  it('defaults API_BIND_ADDRESS to "127.0.0.1" when not set (ADR-0006 localhost-only)', () => {
    const config = parseEnv(VALID_ENV);
    expect(config.API_BIND_ADDRESS).toBe('127.0.0.1');
  });

  it('accepts a valid IPv4 override (0.0.0.0 for compose multi-service)', () => {
    const config = parseEnv({ ...VALID_ENV, API_BIND_ADDRESS: '0.0.0.0' });
    expect(config.API_BIND_ADDRESS).toBe('0.0.0.0');
  });

  it('accepts a specific IPv4 address override', () => {
    const config = parseEnv({ ...VALID_ENV, API_BIND_ADDRESS: '192.168.1.100' });
    expect(config.API_BIND_ADDRESS).toBe('192.168.1.100');
  });

  it('rejects a non-IPv4 value (hostname)', () => {
    expect(() => parseEnv({ ...VALID_ENV, API_BIND_ADDRESS: 'localhost' })).toThrow(
      /^\[config\] invalid env: API_BIND_ADDRESS/,
    );
  });

  it('rejects an IPv6 address', () => {
    expect(() => parseEnv({ ...VALID_ENV, API_BIND_ADDRESS: '::1' })).toThrow(
      /^\[config\] invalid env: API_BIND_ADDRESS/,
    );
  });

  it('produces the SPEC-prescribed error message for invalid API_BIND_ADDRESS', () => {
    expect(() => parseEnv({ ...VALID_ENV, API_BIND_ADDRESS: 'not-an-ip' })).toThrow(
      '[config] invalid env: API_BIND_ADDRESS — must be a valid IPv4 address',
    );
  });
});

// ---------------------------------------------------------------------------
// AUTHZ_SHADOW_MODE (P7 — per-identity authz shadow mode, ADR-0029)
// ---------------------------------------------------------------------------

describe('parseEnv — AUTHZ_SHADOW_MODE', () => {
  it('defaults AUTHZ_SHADOW_MODE to 1 (shadow mode) when not set', () => {
    const config = parseEnv(VALID_ENV);
    expect(config.AUTHZ_SHADOW_MODE).toBe(1);
  });

  it('accepts AUTHZ_SHADOW_MODE=0 (enforce mode)', () => {
    const config = parseEnv({ ...VALID_ENV, AUTHZ_SHADOW_MODE: '0' });
    expect(config.AUTHZ_SHADOW_MODE).toBe(0);
  });

  it('accepts AUTHZ_SHADOW_MODE=1 explicitly', () => {
    const config = parseEnv({ ...VALID_ENV, AUTHZ_SHADOW_MODE: '1' });
    expect(config.AUTHZ_SHADOW_MODE).toBe(1);
  });

  it('rejects AUTHZ_SHADOW_MODE=2 (out of range)', () => {
    expect(() => parseEnv({ ...VALID_ENV, AUTHZ_SHADOW_MODE: '2' })).toThrow(
      /^\[config\] invalid env: AUTHZ_SHADOW_MODE/,
    );
  });

  it('rejects AUTHZ_SHADOW_MODE=-1 (negative)', () => {
    expect(() => parseEnv({ ...VALID_ENV, AUTHZ_SHADOW_MODE: '-1' })).toThrow(
      /^\[config\] invalid env: AUTHZ_SHADOW_MODE/,
    );
  });

  it('rejects AUTHZ_SHADOW_MODE=on (non-numeric)', () => {
    // z.coerce.number() on a non-numeric string produces NaN; int() check rejects NaN
    expect(() => parseEnv({ ...VALID_ENV, AUTHZ_SHADOW_MODE: 'on' })).toThrow(
      /^\[config\] invalid env: AUTHZ_SHADOW_MODE/,
    );
  });
});

// ---------------------------------------------------------------------------
// CCLAW_API_BASE (P6 — documented in schema for drift visibility)
// ---------------------------------------------------------------------------

describe('parseEnv — CCLAW_API_BASE', () => {
  it('is undefined when not set', () => {
    const config = parseEnv(VALID_ENV);
    expect(config.CCLAW_API_BASE).toBeUndefined();
  });

  it('accepts a valid http URL (compose internal)', () => {
    const config = parseEnv({ ...VALID_ENV, CCLAW_API_BASE: 'http://apps-api:7878' });
    expect(config.CCLAW_API_BASE).toBe('http://apps-api:7878');
  });

  it('rejects a non-URL value', () => {
    expect(() => parseEnv({ ...VALID_ENV, CCLAW_API_BASE: 'not-a-url' })).toThrow(
      /^\[config\] invalid env: CCLAW_API_BASE/,
    );
  });
});
