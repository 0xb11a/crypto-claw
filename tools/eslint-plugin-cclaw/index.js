'use strict';

/**
 * ESLint plugin for CryptoClaw invariant enforcement.
 *
 * Rules:
 * - cclaw/require-roles-on-handlers — every HTTP handler must have @Roles(...)
 * - cclaw/require-audited-on-mutating-handlers — every non-GET handler needs @Audited()
 *
 * Both rules enforce the default-deny invariant (SPEC §4 #3, ADR-0019) and the
 * audit policy (SPEC §9.5, ADR-0018).
 */
module.exports = {
  rules: {
    'require-roles-on-handlers': require('./rules/require-roles-on-handlers.js'),
    'require-audited-on-mutating-handlers': require('./rules/require-audited-on-mutating-handlers.js'),
  },
};
