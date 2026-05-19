'use strict';

/**
 * ESLint rule: cclaw/require-identities-on-handlers
 *
 * Every HTTP handler method in a NestJS controller must carry an @Identities(...)
 * decorator (SPEC §9.2, ADR-0009 addendum, P7).
 *
 * This rule mirrors `cclaw/require-roles-on-handlers` for identity-level authz.
 *
 * Status (PR-A): DISABLED in eslint.config.js. Enabled in PR-C once per-agent
 * tokens are plumbed (PR-B) and enforce mode is flipped (PR-C).
 *
 * Detects: class methods decorated with @Get/@Post/@Put/@Patch/@Delete/@All
 * that do NOT have a sibling @Identities(...) decorator.
 */

/** HTTP method decorators that mark a method as an HTTP handler. */
const HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Head', 'Options']);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Every HTTP handler must carry @Identities(...) (SPEC §9.2, ADR-0009 addendum, P7)',
      url: 'https://github.com/0xb11a/crypto-claw/docs/decisions/0029-authz-shadow-mode.md',
    },
    messages: {
      missingIdentities:
        'Handler {{method}} is missing @Identities(...) decorator (per-identity authz, SPEC §9.2, ADR-0009 addendum)',
    },
    schema: [],
  },
  create(context) {
    return {
      MethodDefinition(node) {
        // Only check non-static methods in a class
        if (node.static) return;

        const decorators = node.decorators || [];

        // Check if this method has an HTTP method decorator
        const hasHttpDecorator = decorators.some((dec) => {
          const expr = dec.expression;
          if (!expr) return false;
          // @Get(), @Post(), etc. — CallExpression or Identifier
          const name = expr.type === 'CallExpression' ? expr.callee.name || expr.callee.property?.name : expr.name;
          return HTTP_DECORATORS.has(name);
        });

        if (!hasHttpDecorator) return;

        // Check if this method also has @Identities(...)
        const hasIdentities = decorators.some((dec) => {
          const expr = dec.expression;
          if (!expr) return false;
          const name = expr.type === 'CallExpression' ? expr.callee.name || expr.callee.property?.name : expr.name;
          return name === 'Identities';
        });

        if (!hasIdentities) {
          const methodName = node.key.name || node.key.value || '(anonymous)';
          context.report({
            node,
            messageId: 'missingIdentities',
            data: { method: methodName },
          });
        }
      },
    };
  },
};
