'use strict';

/**
 * ESLint rule: cclaw/require-audited-on-mutating-handlers
 *
 * Every non-GET HTTP handler in a NestJS controller must carry @Audited()
 * (SPEC §9.5, ADR-0018, ADR-0019).
 *
 * Detects: class methods decorated with @Post/@Put/@Patch/@Delete/@All
 * that do NOT have a sibling @Audited() decorator.
 */

/** Non-GET HTTP method decorators. */
const MUTATING_DECORATORS = new Set(['Post', 'Put', 'Patch', 'Delete', 'All']);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Every non-GET HTTP handler must carry @Audited() (SPEC §9.5)',
      url: 'https://github.com/0xb11a/crypto-claw/docs/decisions/0018-audit-log-shape.md',
    },
    messages: {
      missingAudited: 'Non-GET handler {{method}} is missing @Audited() decorator (SPEC §9.5, ADR-0018)',
    },
    schema: [],
  },
  create(context) {
    return {
      MethodDefinition(node) {
        if (node.static) return;

        const decorators = node.decorators || [];

        // Check if this method has a non-GET HTTP method decorator
        const hasMutatingDecorator = decorators.some((dec) => {
          const expr = dec.expression;
          if (!expr) return false;
          const name = expr.type === 'CallExpression' ? expr.callee.name || expr.callee.property?.name : expr.name;
          return MUTATING_DECORATORS.has(name);
        });

        if (!hasMutatingDecorator) return;

        // Check if this method also has @Audited()
        const hasAudited = decorators.some((dec) => {
          const expr = dec.expression;
          if (!expr) return false;
          const name = expr.type === 'CallExpression' ? expr.callee.name || expr.callee.property?.name : expr.name;
          return name === 'Audited';
        });

        if (!hasAudited) {
          const methodName = node.key.name || node.key.value || '(anonymous)';
          context.report({
            node,
            messageId: 'missingAudited',
            data: { method: methodName },
          });
        }
      },
    };
  },
};
