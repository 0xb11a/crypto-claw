/**
 * drift-evaluator.ts — Pure-function port of governance-drift.js evaluators.
 *
 * Bug-for-bug port of:
 *   - `parseListEnv`         (scripts/governance-drift.js)
 *   - `readExpectedSafeConfig`  (scripts/governance-drift.js)
 *   - `readExpectedSquadsConfig` (scripts/governance-drift.js)
 *   - `evaluateSafeDrift`    (scripts/governance-drift.js)
 *   - `evaluateSquadsDrift`  (scripts/governance-drift.js)
 *
 * Key difference from the legacy script: `readExpectedSafeConfig` and
 * `readExpectedSquadsConfig` take a `Record<string, string | undefined>` env
 * argument rather than reading `process.env` directly. The processor passes
 * the resolved subset from ConfigService (ADR-0026).
 *
 * No DI — pure functions with no side effects. Testable in isolation.
 *
 * DoD §I: the legacy `scripts/governance-drift.js` file is unchanged.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DriftAlert {
  type: string;
  severity: 'critical' | 'high' | 'medium';
  detail: string;
}

export interface DriftResult {
  valid: boolean;
  alerts: DriftAlert[];
  skipped?: string;
}

export interface ExpectedSafeConfig {
  owners: Set<string>;
  threshold: number | null;
  modules: Set<string>;
  hasExpectations: boolean;
}

export interface ExpectedSquadsConfig {
  members: Set<string>;
  threshold: number | null;
  hasExpectations: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated env-var string into a sorted Set.
 *
 * Bug-for-bug port of `scripts/governance-drift.js:parseListEnv`.
 *
 * @param raw - Raw string from env var (may be empty, undefined, or null).
 * @param opts.lowercase - Lowercase each entry before adding to the set.
 */
export function parseListEnv(raw: string | undefined | null, opts: { lowercase?: boolean } = {}): Set<string> {
  if (!raw || typeof raw !== 'string') return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (opts.lowercase ? s.toLowerCase() : s)),
  );
}

/**
 * Read expected Safe config for a chain from an env-var record.
 *
 * Bug-for-bug port of `scripts/governance-drift.js:readExpectedSafeConfig`.
 * The only difference: takes an explicit `env` record instead of reading
 * `process.env` (ADR-0026 compliance).
 *
 * @param chainName - Chain name (e.g. 'base', 'ethereum').
 * @param env - Env-var record from ConfigService (subset of AppConfig).
 */
export function readExpectedSafeConfig(chainName: string, env: Record<string, string | undefined>): ExpectedSafeConfig {
  const upper = chainName.toUpperCase();
  const ownersRaw = env[`EXPECTED_SAFE_OWNERS_${upper}`];
  const thresholdRaw = env[`EXPECTED_SAFE_THRESHOLD_${upper}`];
  const modulesRaw = env[`EXPECTED_SAFE_MODULES_${upper}`];
  const owners = parseListEnv(ownersRaw, { lowercase: true });
  const modules = parseListEnv(modulesRaw, { lowercase: true });
  const threshold = thresholdRaw !== undefined && thresholdRaw !== '' ? parseInt(thresholdRaw, 10) : null;
  // hasExpectations: true when owners are set, OR threshold is set, OR either
  // of the raw strings is explicitly present (even if empty — a deliberate
  // zero-value expectation). Bug-for-bug parity with legacy line:
  //   `owners.size > 0 || threshold !== null || ownersRaw === '' || thresholdRaw === ''`
  const hasExpectations = owners.size > 0 || threshold !== null || ownersRaw === '' || thresholdRaw === '';
  return { owners, threshold, modules, hasExpectations };
}

/**
 * Read expected Squads config from an env-var record.
 *
 * Bug-for-bug port of `scripts/governance-drift.js:readExpectedSquadsConfig`.
 */
export function readExpectedSquadsConfig(env: Record<string, string | undefined>): ExpectedSquadsConfig {
  const membersRaw = env['EXPECTED_SQUADS_MEMBERS'];
  const thresholdRaw = env['EXPECTED_SQUADS_THRESHOLD'];
  const members = parseListEnv(membersRaw, { lowercase: false });
  const threshold = thresholdRaw !== undefined && thresholdRaw !== '' ? parseInt(thresholdRaw, 10) : null;
  const hasExpectations = members.size > 0 || threshold !== null;
  return { members, threshold, hasExpectations };
}

// ---------------------------------------------------------------------------
// Drift evaluators
// ---------------------------------------------------------------------------

/**
 * Pure drift predicate for an EVM Safe multisig.
 *
 * Bug-for-bug port of `scripts/governance-drift.js:evaluateSafeDrift`.
 *
 * Checks:
 *   - Owner drift (added OR removed)
 *   - Threshold drift (lowered = critical, raised = high)
 *   - Module drift (any unexpected module = critical)
 *
 * Address comparison is CASE-INSENSITIVE for EVM (Safe API returns
 * checksummed strings; env vars often arrive lowercase).
 */
export function evaluateSafeDrift(input: {
  observedOwners: string[];
  observedThreshold: number;
  observedModules?: string[];
  expected: ExpectedSafeConfig;
}): DriftResult {
  const { observedOwners, observedThreshold, observedModules = [], expected } = input;

  if (!expected.hasExpectations) {
    return { valid: true, alerts: [], skipped: 'no_expected_config_set' };
  }

  const alerts: DriftAlert[] = [];

  // Owner drift — symmetric.
  const observedSet = new Set((observedOwners || []).map((o) => String(o).toLowerCase()));
  const added = [...observedSet].filter((o) => !expected.owners.has(o));
  const removed = [...expected.owners].filter((o) => !observedSet.has(o));
  if (added.length > 0) {
    alerts.push({
      type: 'owner_added',
      severity: 'critical',
      detail: `unexpected owners: ${added.join(', ')}`,
    });
  }
  if (removed.length > 0) {
    alerts.push({
      type: 'owner_removed',
      severity: 'critical',
      detail: `expected owners missing: ${removed.join(', ')}`,
    });
  }

  // Threshold drift.
  if (expected.threshold !== null && Number.isFinite(expected.threshold)) {
    const obs = Number(observedThreshold);
    if (!Number.isFinite(obs)) {
      alerts.push({
        type: 'threshold_unparseable',
        severity: 'critical',
        detail: `observed=${String(observedThreshold)}`,
      });
    } else if (obs < expected.threshold) {
      alerts.push({
        type: 'threshold_lowered',
        severity: 'critical',
        detail: `observed=${obs} < expected=${expected.threshold}`,
      });
    } else if (obs !== expected.threshold) {
      alerts.push({
        type: 'threshold_changed',
        severity: 'high',
        detail: `observed=${obs} expected=${expected.threshold}`,
      });
    }
  }

  // Module drift.
  if (expected.modules.size > 0 || observedModules.length > 0) {
    const observedModSet = new Set((observedModules || []).map((m) => String(m).toLowerCase()));
    const unexpectedModules = [...observedModSet].filter((m) => !expected.modules.has(m));
    if (unexpectedModules.length > 0) {
      alerts.push({
        type: 'module_unexpected',
        severity: 'critical',
        detail: `unexpected modules: ${unexpectedModules.join(', ')}`,
      });
    }
  }

  return { valid: alerts.length === 0, alerts };
}

/**
 * Pure drift predicate for a Squads multisig (Solana).
 *
 * Bug-for-bug port of `scripts/governance-drift.js:evaluateSquadsDrift`.
 *
 * Note: Solana base58 addresses are case-SENSITIVE — compared raw (no lowercase).
 */
export function evaluateSquadsDrift(input: {
  observedMembers: string[];
  observedThreshold: number;
  expected: ExpectedSquadsConfig;
}): DriftResult {
  const { observedMembers, observedThreshold, expected } = input;

  if (!expected.hasExpectations) {
    return { valid: true, alerts: [], skipped: 'no_expected_config_set' };
  }

  const alerts: DriftAlert[] = [];

  const observedSet = new Set(observedMembers || []);
  const added = [...observedSet].filter((m) => !expected.members.has(m));
  const removed = [...expected.members].filter((m) => !observedSet.has(m));
  if (added.length > 0) {
    alerts.push({
      type: 'member_added',
      severity: 'critical',
      detail: `unexpected members: ${added.join(', ')}`,
    });
  }
  if (removed.length > 0) {
    alerts.push({
      type: 'member_removed',
      severity: 'critical',
      detail: `expected members missing: ${removed.join(', ')}`,
    });
  }

  if (expected.threshold !== null && Number.isFinite(expected.threshold)) {
    const obs = Number(observedThreshold);
    if (!Number.isFinite(obs)) {
      alerts.push({
        type: 'threshold_unparseable',
        severity: 'critical',
        detail: `observed=${String(observedThreshold)}`,
      });
    } else if (obs < expected.threshold) {
      alerts.push({
        type: 'threshold_lowered',
        severity: 'critical',
        detail: `observed=${obs} < expected=${expected.threshold}`,
      });
    } else if (obs !== expected.threshold) {
      alerts.push({
        type: 'threshold_changed',
        severity: 'high',
        detail: `observed=${obs} expected=${expected.threshold}`,
      });
    }
  }

  return { valid: alerts.length === 0, alerts };
}
