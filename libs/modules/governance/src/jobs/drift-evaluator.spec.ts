/**
 * Unit tests for drift-evaluator.ts pure functions (SPEC §14, DoD §A).
 *
 * Bug-for-bug parity with `scripts/governance-drift.js` — the same table-driven
 * cases that the legacy script would produce. No I/O, no DI. Pure functions only.
 *
 * Covers:
 *   parseListEnv:
 *     - undefined/null/empty string → empty Set
 *     - comma-separated values → trimmed Set
 *     - lowercase opt
 *     - whitespace trimming
 *
 *   readExpectedSafeConfig:
 *     - all absent → hasExpectations=false
 *     - ownersRaw="" → hasExpectations=true (BUG — footgun, DoD §I: preserve)
 *     - thresholdRaw="" → hasExpectations=true (same footgun)
 *     - normal values → correct owners/threshold/modules
 *
 *   readExpectedSquadsConfig:
 *     - all absent → hasExpectations=false
 *     - members set → hasExpectations=true
 *     - threshold only → hasExpectations=true (vs Safe: threshold only is null → false)
 *
 *   evaluateSafeDrift:
 *     - no expectations → valid, skipped='no_expected_config_set'
 *     - no drift → valid, empty alerts
 *     - owner added (unexpected) → owner_added critical
 *     - owner removed (expected missing) → owner_removed critical
 *     - threshold lowered → threshold_lowered critical
 *     - threshold raised → threshold_changed high
 *     - unexpected module → module_unexpected critical
 *     - multiple simultaneous alerts
 *     - case-insensitive address comparison
 *
 *   evaluateSquadsDrift:
 *     - no expectations → valid, skipped
 *     - member added → member_added critical
 *     - member removed → member_removed critical
 *     - threshold lowered → threshold_lowered critical
 *     - threshold raised → threshold_changed high
 *     - case-SENSITIVE member comparison (Solana base58)
 *
 *   Coder concern #4: empty-string ownersRaw footgun — hasExpectations=true when
 *   EXPECTED_SAFE_OWNERS_BASE="" → drift fires on every observed owner (DoD §I: preserve).
 *
 * SPEC §4 #4: no signer keys.
 * SPEC §4 #6: no process.env reads.
 * DoD §A — every case fails before implementation, passes after.
 * DoD §I — bug-for-bug parity (empty-string footgun preserved).
 */
import { describe, it, expect } from 'vitest';
import {
  parseListEnv,
  readExpectedSafeConfig,
  readExpectedSquadsConfig,
  evaluateSafeDrift,
  evaluateSquadsDrift,
} from './drift-evaluator.js';

// ---------------------------------------------------------------------------
// parseListEnv
// ---------------------------------------------------------------------------

describe('parseListEnv', () => {
  it('returns empty Set for undefined input', () => {
    expect(parseListEnv(undefined).size).toBe(0);
  });

  it('returns empty Set for null input', () => {
    expect(parseListEnv(null).size).toBe(0);
  });

  it('returns empty Set for empty string', () => {
    expect(parseListEnv('').size).toBe(0);
  });

  it('returns empty Set for whitespace-only string', () => {
    expect(parseListEnv('   ').size).toBe(0);
  });

  it('parses a single value correctly', () => {
    const result = parseListEnv('0xABC');
    expect(result.size).toBe(1);
    expect(result.has('0xABC')).toBe(true);
  });

  it('parses comma-separated values into a Set', () => {
    const result = parseListEnv('0xABC,0xDEF,0xGHI');
    expect(result.size).toBe(3);
    expect(result.has('0xABC')).toBe(true);
    expect(result.has('0xDEF')).toBe(true);
    expect(result.has('0xGHI')).toBe(true);
  });

  it('trims whitespace around each entry', () => {
    const result = parseListEnv(' 0xABC , 0xDEF ');
    expect(result.size).toBe(2);
    expect(result.has('0xABC')).toBe(true);
    expect(result.has('0xDEF')).toBe(true);
  });

  it('filters empty entries after split', () => {
    const result = parseListEnv('0xABC,,0xDEF');
    expect(result.size).toBe(2);
  });

  it('lowercases each entry when opts.lowercase=true', () => {
    const result = parseListEnv('0xABCdef,0xGHIjkl', { lowercase: true });
    expect(result.has('0xabcdef')).toBe(true);
    expect(result.has('0xghijkl')).toBe(true);
    expect(result.has('0xABCdef')).toBe(false);
  });

  it('does NOT lowercase when opts.lowercase is absent', () => {
    const result = parseListEnv('0xABCDEF');
    expect(result.has('0xABCDEF')).toBe(true);
    expect(result.has('0xabcdef')).toBe(false);
  });

  it('deduplicates entries with a Set', () => {
    const result = parseListEnv('0xABC,0xABC,0xDEF');
    expect(result.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// readExpectedSafeConfig
// ---------------------------------------------------------------------------

describe('readExpectedSafeConfig', () => {
  it('returns hasExpectations=false when all env vars absent', () => {
    const cfg = readExpectedSafeConfig('base', {});
    expect(cfg.hasExpectations).toBe(false);
    expect(cfg.owners.size).toBe(0);
    expect(cfg.threshold).toBeNull();
    expect(cfg.modules.size).toBe(0);
  });

  it('returns hasExpectations=false when all env vars undefined', () => {
    const cfg = readExpectedSafeConfig('base', {
      EXPECTED_SAFE_OWNERS_BASE: undefined,
      EXPECTED_SAFE_THRESHOLD_BASE: undefined,
      EXPECTED_SAFE_MODULES_BASE: undefined,
    });
    expect(cfg.hasExpectations).toBe(false);
  });

  it('parses owners into lowercase Set', () => {
    const cfg = readExpectedSafeConfig('base', {
      EXPECTED_SAFE_OWNERS_BASE: '0xOwnerA,0xOwnerB',
    });
    expect(cfg.owners.has('0xownera')).toBe(true);
    expect(cfg.owners.has('0xownerb')).toBe(true);
    expect(cfg.hasExpectations).toBe(true);
  });

  it('parses threshold into integer', () => {
    const cfg = readExpectedSafeConfig('base', {
      EXPECTED_SAFE_THRESHOLD_BASE: '2',
    });
    expect(cfg.threshold).toBe(2);
    expect(cfg.hasExpectations).toBe(true);
  });

  it('parses modules into lowercase Set', () => {
    const cfg = readExpectedSafeConfig('base', {
      EXPECTED_SAFE_MODULES_BASE: '0xModA',
    });
    expect(cfg.modules.has('0xmoda')).toBe(true);
  });

  it('uses chainName.toUpperCase() to build env key (ethereum)', () => {
    const cfg = readExpectedSafeConfig('ethereum', {
      EXPECTED_SAFE_OWNERS_ETHEREUM: '0xOwner1',
    });
    expect(cfg.owners.has('0xowner1')).toBe(true);
  });

  // --- Coder concern #4: empty-string footgun (DoD §I) ---
  it('FOOTGUN: hasExpectations=true when ownersRaw="" (empty string explicitly set)', () => {
    // DoD §I: preserve legacy bug-for-bug. EXPECTED_SAFE_OWNERS_BASE=""
    // means hasExpectations=true even though owners Set is empty.
    // Any observed owner will trigger an "owner_added" alert.
    const cfg = readExpectedSafeConfig('base', {
      EXPECTED_SAFE_OWNERS_BASE: '',
    });
    // Empty string is assigned (not undefined) → hasExpectations=true per legacy logic.
    expect(cfg.hasExpectations).toBe(true);
    expect(cfg.owners.size).toBe(0); // Set is empty — everything fires as "added"
  });

  it('FOOTGUN: hasExpectations=true when thresholdRaw="" (empty string explicitly set)', () => {
    const cfg = readExpectedSafeConfig('base', {
      EXPECTED_SAFE_THRESHOLD_BASE: '',
    });
    expect(cfg.hasExpectations).toBe(true);
    expect(cfg.threshold).toBeNull(); // empty string → parseInt('', 10) is NaN → null
  });

  it('threshold is null when thresholdRaw is undefined', () => {
    const cfg = readExpectedSafeConfig('base', {
      EXPECTED_SAFE_OWNERS_BASE: '0xOwner',
    });
    expect(cfg.threshold).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readExpectedSquadsConfig
// ---------------------------------------------------------------------------

describe('readExpectedSquadsConfig', () => {
  it('returns hasExpectations=false when all env vars absent', () => {
    const cfg = readExpectedSquadsConfig({});
    expect(cfg.hasExpectations).toBe(false);
    expect(cfg.members.size).toBe(0);
    expect(cfg.threshold).toBeNull();
  });

  it('returns hasExpectations=true when members are set', () => {
    const cfg = readExpectedSquadsConfig({
      EXPECTED_SQUADS_MEMBERS: 'PubKeyAbc,PubKeyDef',
    });
    expect(cfg.hasExpectations).toBe(true);
    // Solana: NOT lowercased (base58 case-sensitive)
    expect(cfg.members.has('PubKeyAbc')).toBe(true);
    expect(cfg.members.has('PubKeyDef')).toBe(true);
  });

  it('returns hasExpectations=true when threshold only is set', () => {
    const cfg = readExpectedSquadsConfig({
      EXPECTED_SQUADS_THRESHOLD: '2',
    });
    expect(cfg.hasExpectations).toBe(true);
    expect(cfg.threshold).toBe(2);
  });

  it('does NOT lowercase Solana member keys (case-sensitive)', () => {
    const cfg = readExpectedSquadsConfig({
      EXPECTED_SQUADS_MEMBERS: 'ABCDEF123,ghijkl456',
    });
    // Not lowercased
    expect(cfg.members.has('ABCDEF123')).toBe(true);
    expect(cfg.members.has('ghijkl456')).toBe(true);
    expect(cfg.members.has('abcdef123')).toBe(false);
  });

  it('threshold is null when thresholdRaw is undefined', () => {
    const cfg = readExpectedSquadsConfig({
      EXPECTED_SQUADS_MEMBERS: 'PubKey1',
    });
    expect(cfg.threshold).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// evaluateSafeDrift — table-driven
// ---------------------------------------------------------------------------

describe('evaluateSafeDrift', () => {
  const noExpectations = {
    owners: new Set<string>(),
    threshold: null,
    modules: new Set<string>(),
    hasExpectations: false,
  };

  // Fixture uses lowercase keys (matching what readExpectedSafeConfig produces via parseListEnv+lowercase).
  const twoOwners = {
    owners: new Set(['0xownera', '0xownerb']),
    threshold: 2,
    modules: new Set<string>(),
    hasExpectations: true,
  };

  it('returns valid=true with skipped when hasExpectations=false', () => {
    const result = evaluateSafeDrift({
      observedOwners: ['0xAnything'],
      observedThreshold: 1,
      expected: noExpectations,
    });
    expect(result.valid).toBe(true);
    expect(result.alerts).toHaveLength(0);
    expect(result.skipped).toBe('no_expected_config_set');
  });

  it('returns valid=true with no alerts when on-chain state matches expected', () => {
    const result = evaluateSafeDrift({
      observedOwners: ['0xOwnerA', '0xOwnerB'],
      observedThreshold: 2,
      expected: twoOwners,
    });
    expect(result.valid).toBe(true);
    expect(result.alerts).toHaveLength(0);
  });

  it('detects owner_added (unexpected owner) as critical', () => {
    const result = evaluateSafeDrift({
      observedOwners: ['0xOwnerA', '0xOwnerB', '0xUnexpected'],
      observedThreshold: 2,
      expected: twoOwners,
    });
    const alert = result.alerts.find((a) => a.type === 'owner_added');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('critical');
    expect(alert?.detail).toContain('0xunexpected');
    expect(result.valid).toBe(false);
  });

  it('detects owner_removed (expected owner missing) as critical', () => {
    const result = evaluateSafeDrift({
      observedOwners: ['0xOwnerA'], // 0xOwnerB removed (0xOwnerA remains)
      observedThreshold: 2,
      expected: twoOwners,
    });
    const alert = result.alerts.find((a) => a.type === 'owner_removed');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('critical');
    // 0xownerb is missing from observed → appears in removed list
    expect(alert?.detail).toMatch(/0xownerb/);
    expect(result.valid).toBe(false);
  });

  it('detects threshold_lowered as critical', () => {
    const result = evaluateSafeDrift({
      observedOwners: ['0xOwnerA', '0xOwnerB'],
      observedThreshold: 1, // expected=2, observed=1 → lowered
      expected: twoOwners,
    });
    const alert = result.alerts.find((a) => a.type === 'threshold_lowered');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('critical');
    expect(alert?.detail).toContain('observed=1');
    expect(alert?.detail).toContain('expected=2');
  });

  it('detects threshold raised (not lowered) as "threshold_changed" high severity', () => {
    const result = evaluateSafeDrift({
      observedOwners: ['0xOwnerA', '0xOwnerB'],
      observedThreshold: 3, // expected=2, observed=3 → raised (high)
      expected: twoOwners,
    });
    const alert = result.alerts.find((a) => a.type === 'threshold_changed');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('high');
  });

  it('no threshold alert when threshold matches', () => {
    const result = evaluateSafeDrift({
      observedOwners: ['0xOwnerA', '0xOwnerB'],
      observedThreshold: 2,
      expected: twoOwners,
    });
    const thresholdAlerts = result.alerts.filter((a) => a.type.startsWith('threshold'));
    expect(thresholdAlerts).toHaveLength(0);
  });

  it('skips threshold check when expected.threshold is null', () => {
    const expected = { ...twoOwners, threshold: null };
    const result = evaluateSafeDrift({
      observedOwners: ['0xOwnerA', '0xOwnerB'],
      observedThreshold: 99,
      expected,
    });
    const thresholdAlerts = result.alerts.filter((a) => a.type.startsWith('threshold'));
    expect(thresholdAlerts).toHaveLength(0);
  });

  it('detects module_unexpected as critical', () => {
    const expected = {
      owners: new Set(['0xownera']), // lowercase — matching readExpectedSafeConfig output
      threshold: 1,
      modules: new Set<string>(), // no expected modules
      hasExpectations: true,
    };
    const result = evaluateSafeDrift({
      observedOwners: ['0xOwnerA'],
      observedThreshold: 1,
      observedModules: ['0xUnknownModule'],
      expected,
    });
    const alert = result.alerts.find((a) => a.type === 'module_unexpected');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('critical');
    expect(alert?.detail).toContain('0xunknownmodule');
  });

  it('no module alert when observed module is in expected set', () => {
    const expected = {
      owners: new Set(['0xownera']),
      threshold: 1,
      modules: new Set(['0xknownmodule']),
      hasExpectations: true,
    };
    const result = evaluateSafeDrift({
      observedOwners: ['0xOwnerA'],
      observedThreshold: 1,
      observedModules: ['0xKnownModule'],
      expected,
    });
    const moduleAlerts = result.alerts.filter((a) => a.type === 'module_unexpected');
    expect(moduleAlerts).toHaveLength(0);
  });

  it('address comparison is case-insensitive (observed checksummed, expected lowercase)', () => {
    const expected = {
      owners: new Set(['0xabcdef']),
      threshold: 1,
      modules: new Set<string>(),
      hasExpectations: true,
    };
    const result = evaluateSafeDrift({
      observedOwners: ['0xABCDEF'], // Safe API returns checksummed
      observedThreshold: 1,
      expected,
    });
    expect(result.valid).toBe(true);
    expect(result.alerts).toHaveLength(0);
  });

  it('produces multiple simultaneous alerts (owner_added + threshold_lowered)', () => {
    const result = evaluateSafeDrift({
      observedOwners: ['0xOwnerA', '0xOwnerB', '0xAttacker'],
      observedThreshold: 1,
      expected: twoOwners,
    });
    const types = result.alerts.map((a) => a.type);
    expect(types).toContain('owner_added');
    expect(types).toContain('threshold_lowered');
    expect(result.valid).toBe(false);
  });

  it('handles empty observedOwners array (all expected owners removed)', () => {
    const result = evaluateSafeDrift({
      observedOwners: [],
      observedThreshold: 2,
      expected: twoOwners,
    });
    const removedAlert = result.alerts.find((a) => a.type === 'owner_removed');
    expect(removedAlert).toBeDefined();
  });

  it('handles undefined observedModules (defaults to [])', () => {
    const expected = {
      owners: new Set(['0xownera']),
      threshold: 1,
      modules: new Set(['0xmod']),
      hasExpectations: true,
    };
    // observedModules not provided — no module drift
    const result = evaluateSafeDrift({
      observedOwners: ['0xOwnerA'],
      observedThreshold: 1,
      expected,
    });
    // No observed modules means nothing "unexpected" — but the expected module is present and not observed.
    // Legacy: module_unexpected only fires for modules in observed but NOT in expected (not the reverse).
    const alert = result.alerts.find((a) => a.type === 'module_unexpected');
    expect(alert).toBeUndefined();
  });

  // Coder concern #4 demonstration test
  it('FOOTGUN demo: empty ownersRaw causes owner_added on any observed owner', () => {
    // When EXPECTED_SAFE_OWNERS_BASE="" the config built by readExpectedSafeConfig has:
    //   owners=Set{} (empty), hasExpectations=true
    // Any observed owner is "unexpected" → owner_added fires.
    const emptyOwnersConfig = {
      owners: new Set<string>(), // what readExpectedSafeConfig produces for ""
      threshold: null,
      modules: new Set<string>(),
      hasExpectations: true, // BUG: always true when raw==""
    };
    const result = evaluateSafeDrift({
      observedOwners: ['0xLegitimateOwner'],
      observedThreshold: 1,
      expected: emptyOwnersConfig,
    });
    const alert = result.alerts.find((a) => a.type === 'owner_added');
    // The footgun: legitimate owner triggers alert because expected set is empty.
    expect(alert).toBeDefined();
    expect(alert?.detail).toContain('0xlegitimateowner');
  });
});

// ---------------------------------------------------------------------------
// evaluateSquadsDrift — table-driven
// ---------------------------------------------------------------------------

describe('evaluateSquadsDrift', () => {
  const noExpectations = {
    members: new Set<string>(),
    threshold: null,
    hasExpectations: false,
  };

  const twoMembers = {
    members: new Set(['PubKeyAlpha', 'PubKeyBeta']),
    threshold: 2,
    hasExpectations: true,
  };

  it('returns valid=true with skipped when hasExpectations=false', () => {
    const result = evaluateSquadsDrift({
      observedMembers: ['AnyMember'],
      observedThreshold: 1,
      expected: noExpectations,
    });
    expect(result.valid).toBe(true);
    expect(result.alerts).toHaveLength(0);
    expect(result.skipped).toBe('no_expected_config_set');
  });

  it('returns valid=true with no alerts when observed matches expected', () => {
    const result = evaluateSquadsDrift({
      observedMembers: ['PubKeyAlpha', 'PubKeyBeta'],
      observedThreshold: 2,
      expected: twoMembers,
    });
    expect(result.valid).toBe(true);
    expect(result.alerts).toHaveLength(0);
  });

  it('detects member_added (unexpected member) as critical', () => {
    const result = evaluateSquadsDrift({
      observedMembers: ['PubKeyAlpha', 'PubKeyBeta', 'AttackerKey'],
      observedThreshold: 2,
      expected: twoMembers,
    });
    const alert = result.alerts.find((a) => a.type === 'member_added');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('critical');
    expect(alert?.detail).toContain('AttackerKey');
  });

  it('detects member_removed (expected member missing) as critical', () => {
    const result = evaluateSquadsDrift({
      observedMembers: ['PubKeyAlpha'], // PubKeyBeta missing
      observedThreshold: 2,
      expected: twoMembers,
    });
    const alert = result.alerts.find((a) => a.type === 'member_removed');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('critical');
    expect(alert?.detail).toContain('PubKeyBeta');
  });

  it('detects threshold_lowered as critical', () => {
    const result = evaluateSquadsDrift({
      observedMembers: ['PubKeyAlpha', 'PubKeyBeta'],
      observedThreshold: 1, // expected=2
      expected: twoMembers,
    });
    const alert = result.alerts.find((a) => a.type === 'threshold_lowered');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('critical');
  });

  it('detects threshold_changed (raised) as high', () => {
    const result = evaluateSquadsDrift({
      observedMembers: ['PubKeyAlpha', 'PubKeyBeta'],
      observedThreshold: 3, // expected=2 → raised
      expected: twoMembers,
    });
    const alert = result.alerts.find((a) => a.type === 'threshold_changed');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('high');
  });

  it('comparison is CASE-SENSITIVE for Solana base58 keys', () => {
    // Solana: PubKeyAlpha ≠ pubkeyalpha (different addresses on-chain)
    const result = evaluateSquadsDrift({
      observedMembers: ['pubkeyalpha', 'PubKeyBeta'], // lowercase variant of expected
      observedThreshold: 2,
      expected: twoMembers,
    });
    // 'pubkeyalpha' is different from 'PubKeyAlpha' → added
    // 'PubKeyAlpha' missing → removed
    const addedAlert = result.alerts.find((a) => a.type === 'member_added');
    const removedAlert = result.alerts.find((a) => a.type === 'member_removed');
    expect(addedAlert).toBeDefined();
    expect(removedAlert).toBeDefined();
    expect(result.valid).toBe(false);
  });

  it('skips threshold check when expected.threshold is null', () => {
    const expected = { ...twoMembers, threshold: null };
    const result = evaluateSquadsDrift({
      observedMembers: ['PubKeyAlpha', 'PubKeyBeta'],
      observedThreshold: 99,
      expected,
    });
    const thresholdAlerts = result.alerts.filter((a) => a.type.startsWith('threshold'));
    expect(thresholdAlerts).toHaveLength(0);
  });

  it('handles empty observedMembers (all expected members removed)', () => {
    const result = evaluateSquadsDrift({
      observedMembers: [],
      observedThreshold: 2,
      expected: twoMembers,
    });
    expect(result.alerts.some((a) => a.type === 'member_removed')).toBe(true);
  });
});
