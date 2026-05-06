// ============================================================
// governance-drift.js — Detect Safe / Squads multisig config drift
// (PR 3.2)
//
// Defangs threat #18 (multisig owner / threshold drift). A silent
// governance attack — adding an attacker-controlled owner, lowering
// the threshold to 1, enabling a malicious Safe module — is the
// highest-leverage compromise possible: it doesn't drain anything
// immediately, it grants permanent unilateral control. The next
// "legitimate" transaction is the drain.
//
// We capture the EXPECTED config in env vars at fund setup, then
// re-read the on-chain state daily (via a cron) and assert nothing
// has changed. Any drift fires a critical Telegram alert.
//
// Design choice: addresses are compared CASE-INSENSITIVELY for EVM
// (since Safe APIs return checksummed strings but env vars often
// arrive lowercase). Solana base58 is case-sensitive — compared raw.
// ============================================================

import { isEVM, isSolana } from './chains.js';

/**
 * Parse a comma-separated env-var string into a sorted Set of
 * lowercase entries (for EVM) or raw strings (for Solana).
 */
function parseListEnv(raw, { lowercase = false } = {}) {
  if (!raw || typeof raw !== 'string') return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (lowercase ? s.toLowerCase() : s)),
  );
}

/**
 * Read the expected Safe config for a chain from env vars.
 * @returns {{ owners: Set<string>, threshold: number|null, modules: Set<string>, hasExpectations: boolean }}
 */
export function readExpectedSafeConfig(chainName, env = process.env) {
  const upper = chainName.toUpperCase();
  const ownersRaw = env[`EXPECTED_SAFE_OWNERS_${upper}`];
  const thresholdRaw = env[`EXPECTED_SAFE_THRESHOLD_${upper}`];
  const modulesRaw = env[`EXPECTED_SAFE_MODULES_${upper}`];
  const owners = parseListEnv(ownersRaw, { lowercase: true });
  const modules = parseListEnv(modulesRaw, { lowercase: true });
  const threshold = thresholdRaw !== undefined && thresholdRaw !== '' ? parseInt(thresholdRaw, 10) : null;
  const hasExpectations = owners.size > 0 || threshold !== null || ownersRaw === '' || thresholdRaw === '';
  return { owners, threshold, modules, hasExpectations };
}

/**
 * Read the expected Squads config from env vars.
 * @returns {{ members: Set<string>, threshold: number|null, hasExpectations: boolean }}
 */
export function readExpectedSquadsConfig(env = process.env) {
  const membersRaw = env.EXPECTED_SQUADS_MEMBERS;
  const thresholdRaw = env.EXPECTED_SQUADS_THRESHOLD;
  const members = parseListEnv(membersRaw, { lowercase: false });
  const threshold = thresholdRaw !== undefined && thresholdRaw !== '' ? parseInt(thresholdRaw, 10) : null;
  const hasExpectations = members.size > 0 || threshold !== null;
  return { members, threshold, hasExpectations };
}

/**
 * Pure drift predicate for an EVM Safe.
 *
 * @param {object} input
 * @param {string[]} input.observedOwners
 * @param {number} input.observedThreshold
 * @param {string[]} [input.observedModules=[]]
 * @param {{owners: Set<string>, threshold: number|null, modules: Set<string>, hasExpectations: boolean}} input.expected
 * @returns {{ valid: boolean, alerts: Array<{type: string, severity: string, detail: string}>, skipped?: string }}
 */
export function evaluateSafeDrift({ observedOwners, observedThreshold, observedModules = [], expected }) {
  if (!expected.hasExpectations) {
    return { valid: true, alerts: [], skipped: 'no_expected_config_set' };
  }
  const alerts = [];

  // Owner drift — symmetric (added OR removed).
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

  // Threshold drift — only when an expectation is set.
  if (expected.threshold !== null && Number.isFinite(expected.threshold)) {
    const obs = Number(observedThreshold);
    if (!Number.isFinite(obs)) {
      alerts.push({ type: 'threshold_unparseable', severity: 'critical', detail: `observed=${observedThreshold}` });
    } else if (obs < expected.threshold) {
      // Lowering threshold is the dangerous direction.
      alerts.push({
        type: 'threshold_lowered',
        severity: 'critical',
        detail: `observed=${obs} < expected=${expected.threshold}`,
      });
    } else if (obs !== expected.threshold) {
      // Higher threshold isn't a drain risk but still indicates drift.
      alerts.push({
        type: 'threshold_changed',
        severity: 'high',
        detail: `observed=${obs} expected=${expected.threshold}`,
      });
    }
  }

  // Module drift — modules ⊆ expected. Any unexpected module is critical
  // (Safe modules can execute transactions without going through the
  // multisig).
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
 * @param {object} input
 * @param {string[]} input.observedMembers
 * @param {number} input.observedThreshold
 * @param {{members: Set<string>, threshold: number|null, hasExpectations: boolean}} input.expected
 * @returns {{ valid: boolean, alerts: Array<{type: string, severity: string, detail: string}>, skipped?: string }}
 */
export function evaluateSquadsDrift({ observedMembers, observedThreshold, expected }) {
  if (!expected.hasExpectations) {
    return { valid: true, alerts: [], skipped: 'no_expected_config_set' };
  }
  const alerts = [];

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
      alerts.push({ type: 'threshold_unparseable', severity: 'critical', detail: `observed=${observedThreshold}` });
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

/**
 * Convenience top-level orchestrator. Given a chain name, picks the
 * right evaluator, fetches expectations, returns drift result.
 * (The actual on-chain reads are done by check-safe-status.js /
 * check-squads-status.js — this just glues them.)
 */
export function evaluateChainDrift(chainName, observed, env = process.env) {
  if (isEVM(chainName)) {
    return evaluateSafeDrift({
      observedOwners: observed.owners,
      observedThreshold: observed.threshold,
      observedModules: observed.modules,
      expected: readExpectedSafeConfig(chainName, env),
    });
  }
  if (isSolana(chainName)) {
    return evaluateSquadsDrift({
      observedMembers: observed.members,
      observedThreshold: observed.threshold,
      expected: readExpectedSquadsConfig(env),
    });
  }
  return { valid: true, alerts: [], skipped: `unsupported_chain: ${chainName}` };
}
