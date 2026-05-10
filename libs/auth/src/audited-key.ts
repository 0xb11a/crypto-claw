/**
 * Shared metadata key for @Audited() decorator.
 *
 * Exported from libs/auth (not libs/audit) so the route walker can read
 * it without creating a circular dependency between libs/auth and libs/audit.
 */
export const AUDITED_KEY = 'audited';
