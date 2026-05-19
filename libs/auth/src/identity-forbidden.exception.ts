import { ForbiddenException } from '@nestjs/common';

/**
 * Typed subclass of ForbiddenException thrown by IdentityGuard in enforce mode.
 *
 * Using a typed subclass instead of a bare ForbiddenException allows the
 * IdentityForbiddenFilter to catch ONLY guard-thrown 403s (not service-layer
 * ForbiddenExceptions) and write an audit row for each one.
 *
 * Plan §Risks #6 (PR-C1): IdentityGuard.throw() runs BEFORE AuditInterceptor.tap(),
 * so a plain ForbiddenException thrown by the guard produces no audit row. This class
 * is the companion to IdentityForbiddenFilter in libs/audit/src/identity-forbidden.filter.ts,
 * which catches this specific subclass and writes the audit row.
 *
 * SPEC §9.2, ADR-0009 addendum, ADR-0029, P7 PR-C1.
 */
export class IdentityForbiddenException extends ForbiddenException {
  /**
   * @param message - Human-readable denial reason (included in the 403 body).
   */
  constructor(message: string) {
    super(message);
    // Restore correct prototype chain — required when extending built-in Error subclasses in TS.
    Object.setPrototypeOf(this, IdentityForbiddenException.prototype);
  }
}
