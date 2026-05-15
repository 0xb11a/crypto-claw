/**
 * SquadsRpcAdapter — stub for Squads V4 RPC queries.
 *
 * SDK port pending. All methods throw SquadsRpcNotImplementedError.
 * Consumer processors must guard the Solana branch with an explicit
 * feature-flag skip; do NOT swallow these errors.
 *
 * Rationale (PR-D blocker fix):
 *   The PR-D implementation used a placeholder `{ dataSize: 0 }` filter in
 *   `getPendingTransactions` that always returned `[]`, causing every
 *   `queued_in_squads` receipt to be falsely marked executed on the first
 *   cycle. Separately, `parseMultisigAccountData` had incorrect Borsh offsets
 *   (missed `config_authority` 1+32 bytes and `bump` 1 byte), producing garbage
 *   data that drove daily false `member_removed` alerts.
 *
 *   The reviewer chose option (b): feature-flag Solana off and let the legacy
 *   `scripts/track-multisig.js` + `scripts/governance-drift.js` continue
 *   handling Solana via `entrypoint.sh` until a proper SDK port lands in its
 *   own dedicated PR (with `@sqds/multisig` dependency + real fixture validation).
 *
 * Used by:
 *   - governance-drift processor — Solana branch now feature-flag skipped; EVM
 *     path unaffected.
 *   - multisig-tracking processor — Solana branch now feature-flag skipped; EVM
 *     path unaffected.
 *
 * SPEC §4 #4 — SQUADS_SIGNER_KEY is never read here.
 * SPEC §4 #6 — no process.env reads; all config via ConfigService.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when SQUADS_MULTISIG_ADDRESS is not configured. */
export class SquadsAddressMissingError extends Error {
  constructor() {
    super('SQUADS_MULTISIG_ADDRESS is not configured — Squads RPC calls are unavailable');
    this.name = 'SquadsAddressMissingError';
  }
}

/** Thrown when RPC_SOL is not configured. */
export class SquadsRpcUrlMissingError extends Error {
  constructor() {
    super('RPC_SOL is not configured — Squads RPC calls are unavailable');
    this.name = 'SquadsRpcUrlMissingError';
  }
}

/** Thrown when the Squads RPC returns an error response. */
export class SquadsRpcError extends Error {
  constructor(
    public readonly method: string,
    public readonly message: string,
  ) {
    super(`Squads RPC error (${method}): ${message}`);
    this.name = 'SquadsRpcError';
  }
}

/**
 * Thrown by all SquadsRpcAdapter methods until the full SDK port lands.
 *
 * Consumer processors (governance-drift, multisig-tracker) guard the Solana
 * branch with an explicit feature-flag skip BEFORE calling any adapter method,
 * so this error is never reached in production. The throw-on-call behaviour
 * is defence-in-depth: if any future consumer accidentally invokes these
 * methods, the failure is loud rather than silently producing bad data.
 */
export class SquadsRpcNotImplementedError extends Error {
  constructor(method: string) {
    super(
      `SquadsRpcAdapter.${method}() is not implemented. ` +
        'SDK port pending — Solana multisig tracking is handled by ' +
        'entrypoint.sh:run_executor_loop (scripts/track-multisig.js) until ' +
        'a dedicated PR adds @sqds/multisig with real fixture validation.',
    );
    this.name = 'SquadsRpcNotImplementedError';
  }
}

// ---------------------------------------------------------------------------
// Public return types
// ---------------------------------------------------------------------------

/** Multisig member info returned by `getMultisigInfo`. */
export interface SquadsMultisigInfo {
  /** Array of member public key strings (base58). */
  members: string[];
  /** Current signing threshold. */
  threshold: number;
}

/** Pending Squads transaction info. */
export interface SquadsPendingTransaction {
  /** Transaction index (stored in `receipts.safe_nonce` per OPEN-8). */
  transactionIndex: number;
  /** Number of approvals collected so far. */
  approved: number;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * NestJS injectable adapter for Squads V4 multisig RPC queries.
 *
 * All methods currently throw {@link SquadsRpcNotImplementedError}.
 *
 * The original PR-D implementation had two blockers:
 *   1. `getPendingTransactions` used `{ dataSize: 0 }` as a placeholder filter
 *      that always returns `[]` from the RPC, causing the multisig-tracking
 *      processor to falsely mark every `queued_in_squads` receipt as executed.
 *   2. `parseMultisigAccountData` missed `config_authority` (1+32 bytes) and
 *      `bump` (1 byte) between `create_key` and `threshold`, yielding garbage
 *      data that drove daily false `member_removed` alerts.
 *
 * Rather than attempt an inline fix (which requires `@sqds/multisig` dependency
 * + live RPC fixture validation), the reviewer selected option (b): stub the
 * adapter and explicitly skip Solana in both consumer processors so the legacy
 * `scripts/track-multisig.js` and `scripts/governance-drift.js` remain the
 * authoritative Solana handlers until a dedicated SDK-port PR lands.
 *
 * For tests: mock `SquadsRpcAdapter.getMultisigInfo` and
 * `SquadsRpcAdapter.getPendingTransactions` via vi.spyOn.
 */
@Injectable()
export class SquadsRpcAdapter {
  private readonly logger = new Logger(SquadsRpcAdapter.name);

  /**
   * ConfigService retained so the DI graph stays stable.
   * Tests construct SquadsRpcAdapter via the NestJS testing module, which
   * requires ConfigService to remain in the constructor signature.
   */
  constructor(private readonly _configService: ConfigService) {}

  /**
   * Fetch Squads multisig member list and threshold.
   *
   * @throws {SquadsRpcNotImplementedError} Always — SDK port pending.
   *   Consumer processors must guard the Solana branch with a feature-flag
   *   skip BEFORE calling this method.
   *
   * @param _signal - Unused until the real implementation lands.
   */
  async getMultisigInfo(_signal?: AbortSignal): Promise<SquadsMultisigInfo> {
    this.logger.debug('squads-rpc: getMultisigInfo — SDK port pending, throwing NotImplementedError');
    throw new SquadsRpcNotImplementedError('getMultisigInfo');
  }

  /**
   * Fetch pending Squads transactions.
   *
   * @throws {SquadsRpcNotImplementedError} Always — SDK port pending.
   *   Consumer processors must guard the Solana branch with a feature-flag
   *   skip BEFORE calling this method.
   *
   * @param _signal - Unused until the real implementation lands.
   */
  async getPendingTransactions(_signal?: AbortSignal): Promise<SquadsPendingTransaction[]> {
    this.logger.debug('squads-rpc: getPendingTransactions — SDK port pending, throwing NotImplementedError');
    throw new SquadsRpcNotImplementedError('getPendingTransactions');
  }
}
