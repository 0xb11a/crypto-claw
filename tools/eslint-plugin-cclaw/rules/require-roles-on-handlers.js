'use strict';

/**
 * ESLint rule: cclaw/require-roles-on-handlers
 *
 * Every HTTP handler method in a NestJS controller must carry a @Roles(...)
 * decorator (SPEC §4 #3, ADR-0019).
 *
 * Detects: class methods decorated with @Get/@Post/@Put/@Patch/@Delete/@All
 * that do NOT have a sibling @Roles(...) decorator.
 */

/** HTTP method decorators that mark a method as an HTTP handler. */
const HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Head', 'Options']);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Every HTTP handler must carry @Roles(...) (SPEC §4 #3)',
      url: 'https://github.com/0xb11a/crypto-claw/docs/decisions/0019-default-deny-route-walker.md',
    },
    messages: {
      missingRoles: 'Handler {{method}} is missing @Roles(...) decorator (default-deny, SPEC §4 #3)',
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

        // Check if this method also has @Roles(...)
        const hasRoles = decorators.some((dec) => {
          const expr = dec.expression;
          if (!expr) return false;
          const name = expr.type === 'CallExpression' ? expr.callee.name || expr.callee.property?.name : expr.name;
          return name === 'Roles';
        });

        if (!hasRoles) {
          const methodName = node.key.name || node.key.value || '(anonymous)';
          context.report({
            node,
            messageId: 'missingRoles',
            data: { method: methodName },
          });
        }
      },
    };
  },
};
