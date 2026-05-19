'use strict';

/**
 * ESLint plugin for CryptoClaw invariant enforcement.
 *
 * Rules:
 * - cclaw/require-roles-on-handlers — every HTTP handler must have @Roles(...)
 * - cclaw/require-audited-on-mutating-handlers — every non-GET handler needs @Audited()
 * - cclaw/require-identities-on-handlers — every HTTP handler must have @Identities(...) (P7, enabled in PR-C1)
 *
 * The first two rules enforce the default-deny invariant (SPEC §4 #3, ADR-0019)
 * and the audit policy (SPEC §9.5, ADR-0018).
 *
 * The third rule enforces per-identity authz (SPEC §9.2, ADR-0009 addendum, P7).
 * It was disabled in PR-A + PR-B; ENABLED in PR-C1 as an error-level rule.
 */
module.exports = {
  rules: {
    'require-roles-on-handlers': require('./rules/require-roles-on-handlers.js'),
    'require-audited-on-mutating-handlers': require('./rules/require-audited-on-mutating-handlers.js'),
    'require-identities-on-handlers': require('./rules/require-identities-on-handlers.js'),
  },
};
