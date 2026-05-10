import { SetMetadata } from '@nestjs/common';
import { AUDITED_KEY } from '@cclaw/auth';

/**
 * Mark a controller handler for audit logging (SPEC §9.5, ADR-0018).
 *
 * Every non-GET handler must carry @Audited(). The AuditInterceptor fires
 * on every method with this metadata, writing a service_audit row after
 * the response completes (fire-and-forget via RxJS tap).
 *
 * Lint rule cclaw/require-audited-on-mutating-handlers enforces this at
 * PR time; the boot-time route walker (RouteWalkerService) enforces it at
 * startup as a safety net.
 */
export const Audited = () => SetMetadata(AUDITED_KEY, true);
