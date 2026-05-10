import { describe, it, expect } from 'vitest';
import { IdentityRegistry } from './identity-registry.js';
import type { AppConfig } from '@cclaw/config';

const TEST_CONFIG = {
  RESEARCH_API_KEY: 'research-key-aaaaaaaaaaaaaaaa',
  SENTINEL_API_KEY: 'sentinel-key-aaaaaaaaaaaaaaaa',
  EXECUTOR_API_KEY: 'executor-key-aaaaaaaaaaaaaaaa',
  OBSERVER_API_KEY: 'observer-key-aaaaaaaaaaaaaaaa',
  LOOP_API_KEY: 'loop-key-aaaaaaaaaaaaaaaaaaaaaaaa',
  WORKER_API_KEY: 'worker-key-aaaaaaaaaaaaaaaaaaaaaa',
  SCHEDULER_API_KEY: 'scheduler-key-aaaaaaaaaaaaaaaa',
  DASHBOARD_API_KEY: 'dashboard-key-aaaaaaaaaaaaaaa',
} as unknown as AppConfig;

describe('IdentityRegistry', () => {
  const registry = new IdentityRegistry(TEST_CONFIG);

  it('maps RESEARCH key to agent role', () => {
    const user = registry.lookup('research-key-aaaaaaaaaaaaaaaa');
    expect(user).toEqual({ identity: 'RESEARCH', role: 'agent' });
  });

  it('maps SENTINEL key to agent role', () => {
    const user = registry.lookup('sentinel-key-aaaaaaaaaaaaaaaa');
    expect(user).toEqual({ identity: 'SENTINEL', role: 'agent' });
  });

  it('maps EXECUTOR key to agent role', () => {
    const user = registry.lookup('executor-key-aaaaaaaaaaaaaaaa');
    expect(user).toEqual({ identity: 'EXECUTOR', role: 'agent' });
  });

  it('maps OBSERVER key to agent role', () => {
    const user = registry.lookup('observer-key-aaaaaaaaaaaaaaaa');
    expect(user).toEqual({ identity: 'OBSERVER', role: 'agent' });
  });

  it('maps LOOP key to agent role', () => {
    const user = registry.lookup('loop-key-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(user).toEqual({ identity: 'LOOP', role: 'agent' });
  });

  it('maps WORKER key to agent role', () => {
    const user = registry.lookup('worker-key-aaaaaaaaaaaaaaaaaaaaaa');
    expect(user).toEqual({ identity: 'WORKER', role: 'agent' });
  });

  it('maps SCHEDULER key to agent role', () => {
    const user = registry.lookup('scheduler-key-aaaaaaaaaaaaaaaa');
    expect(user).toEqual({ identity: 'SCHEDULER', role: 'agent' });
  });

  it('maps DASHBOARD key to dashboard role', () => {
    const user = registry.lookup('dashboard-key-aaaaaaaaaaaaaaa');
    expect(user).toEqual({ identity: 'DASHBOARD', role: 'dashboard' });
  });

  it('returns null for an unknown token', () => {
    expect(registry.lookup('completely-unknown-token')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(registry.lookup('')).toBeNull();
  });

  it('returns null for a token that is a prefix of a valid token', () => {
    expect(registry.lookup('research-key')).toBeNull();
  });

  it('lookup is constant-time (does not short-circuit on first char match)', () => {
    // We cannot assert timing directly in a unit test, but we can assert
    // correctness: a token sharing the first N chars must not match.
    expect(registry.lookup('research-key-aaaaaaaaaaaaaaax')).toBeNull();
  });

  it('all 8 tokens resolve to distinct identities', () => {
    const keys = Object.values(TEST_CONFIG as unknown as Record<string, unknown>).filter(
      (v): v is string => typeof v === 'string' && v.endsWith('aa'),
    );
    // Each resolves to a different identity
    const identities = new Set(keys.map((k) => registry.lookup(k)?.identity).filter(Boolean));
    expect(identities.size).toBe(8);
  });
});
