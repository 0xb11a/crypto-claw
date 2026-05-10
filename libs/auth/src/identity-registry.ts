import { timingSafeEqual, createHash } from 'node:crypto';
import type { AppConfig } from '@cclaw/config';

/** All supported identity names (SPEC §9.1). */
export type IdentityName =
  | 'RESEARCH'
  | 'SENTINEL'
  | 'EXECUTOR'
  | 'OBSERVER'
  | 'LOOP'
  | 'WORKER'
  | 'SCHEDULER'
  | 'DASHBOARD';

/** Role values — agent has full read+write, dashboard is read-only (SPEC §9.1). */
export type RoleName = 'agent' | 'dashboard';

/** Resolved identity + role pair placed on req.user by BearerAuthGuard. */
export interface AuthenticatedUser {
  identity: IdentityName;
  role: RoleName;
}

/** Mapping entry stored in the registry. */
interface RegistryEntry {
  identity: IdentityName;
  role: RoleName;
  /** Raw Buffer of the token — used for constant-time comparison. */
  tokenBuf: Buffer;
}

/**
 * Identity registry built once from AppConfig at module init.
 *
 * Maps each of the 8 *_API_KEY fields to a { identity, role } pair.
 * Token lookup uses `crypto.timingSafeEqual` so comparison doesn't leak
 * timing information (SPEC §9.1).
 */
export class IdentityRegistry {
  private readonly entries: RegistryEntry[];

  constructor(config: AppConfig) {
    this.entries = [
      { identity: 'RESEARCH', role: 'agent', tokenBuf: Buffer.from(config.RESEARCH_API_KEY, 'utf8') },
      { identity: 'SENTINEL', role: 'agent', tokenBuf: Buffer.from(config.SENTINEL_API_KEY, 'utf8') },
      { identity: 'EXECUTOR', role: 'agent', tokenBuf: Buffer.from(config.EXECUTOR_API_KEY, 'utf8') },
      { identity: 'OBSERVER', role: 'agent', tokenBuf: Buffer.from(config.OBSERVER_API_KEY, 'utf8') },
      { identity: 'LOOP', role: 'agent', tokenBuf: Buffer.from(config.LOOP_API_KEY, 'utf8') },
      { identity: 'WORKER', role: 'agent', tokenBuf: Buffer.from(config.WORKER_API_KEY, 'utf8') },
      { identity: 'SCHEDULER', role: 'agent', tokenBuf: Buffer.from(config.SCHEDULER_API_KEY, 'utf8') },
      { identity: 'DASHBOARD', role: 'dashboard', tokenBuf: Buffer.from(config.DASHBOARD_API_KEY, 'utf8') },
    ];
  }

  /**
   * Look up a bearer token and return the identity + role pair.
   *
   * Uses constant-time comparison for all entries (SPEC §9.1).
   * Returns null if no entry matches.
   *
   * @param token - Raw token extracted from the Authorization header (without 'Bearer ' prefix)
   */
  lookup(token: string): AuthenticatedUser | null {
    // We hash both sides to ensure same-length comparison (timingSafeEqual requires equal lengths).
    // sha256 output is always 32 bytes regardless of input length.
    const inBuf = createHash('sha256').update(token, 'utf8').digest();

    for (const entry of this.entries) {
      const refBuf = createHash('sha256').update(entry.tokenBuf).digest();
      if (timingSafeEqual(inBuf, refBuf)) {
        return { identity: entry.identity, role: entry.role };
      }
    }
    return null;
  }
}
