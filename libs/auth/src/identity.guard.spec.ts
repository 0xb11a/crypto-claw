/**
 * Unit tests for IdentityGuard — the P1a–P6 no-op shim (ADR-0009).
 *
 * In P7 this guard will enforce @Identities(…). Until then, it must:
 * - Always return true (pass every request through)
 * - Not inspect any metadata or request properties
 *
 * DoD §A — every code change has a test.
 */

import { describe, it, expect } from 'vitest';
import { IdentityGuard } from './identity.guard.js';

describe('IdentityGuard (P1a–P6 no-op shim)', () => {
  const guard = new IdentityGuard();

  it('always returns true regardless of context', () => {
    expect(guard.canActivate()).toBe(true);
  });

  it('returns true for every call (consistent no-op)', () => {
    for (let i = 0; i < 5; i++) {
      expect(guard.canActivate()).toBe(true);
    }
  });
});
