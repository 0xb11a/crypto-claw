/**
 * SquadsRpcAdapter — real Squads V4 SDK adapter for multisig RPC queries.
 *
 * This replaces the placeholder stub (PR-D option-b) with a full implementation
 * backed by `@sqds/multisig`. The `SquadsRpcNotImplementedError` class has been
 * removed; its absence is the visible signal that the SDK port is complete.
 *
 * Implementation notes:
 *   - Dynamic import is used for `@sqds/multisig` and `@solana/web3.js` (see
 *     IMPORT_STRATEGY below). This mirrors `apps/executor/src/execute-trade-solana.ts`
 *     and avoids CJS/ESM interop failures in CI environments that run the worker
 *     boot smoke test with EXECUTOR_STUB_MODE.
 *   - Per-call Connection (not a cached singleton). Simpler; matches legacy
 *     `scripts/check-squads-status.js` (locked decision OPEN-SDK-2).
 *   - The RPC URL is never logged (may contain API key in path).
 *   - `SQUADS_SIGNER_KEY` is never read (SPEC §4 #4).
 *   - All config access goes through ConfigService (SPEC §4 #6, ADR-0026).
 *
 * IMPORT_STRATEGY — ESM/CJS interop:
 *   `libs/adapters/squads-rpc` is declared `"type": "commonjs"`, matching
 *   `apps/executor`. The Squads SDK and Solana SDK are published as ESM.
 *   Static `import * as` of an ESM package from CJS works in Node 22 only when
 *   the runtime honours `exports` / `main` fallbacks — the CI node_modules
 *   layout can make this flaky. Using `await import(...)` at method-call time
 *   (lazy dynamic import) is the safest pattern proven in execute-trade-solana.ts.
 *   Locked decision #8 in the plan.
 *
 * Scan window:
 *   Latest 20 transaction indices descending from the current
 *   `transactionIndex` on the multisig account. Mirrors legacy
 *   `scripts/check-squads-status.js:119-121`. Bounded limit: documented.
 *
 * Used by:
 *   - governance-drift processor — Solana branch.
 *   - multisig-tracking processor — Solana branch (`handleSquadsReceipt`).
 *
 * SPEC §4 #4 — SQUADS_SIGNER_KEY is never read here.
 * SPEC §4 #6 — no process.env reads; all config via ConfigService.
 * ADR-0026 — per-field ConfigService access only.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getChain, isSolana } from '@cclaw/chain';

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
    message: string,
  ) {
    super(`Squads RPC error (${method}): ${message}`);
    this.name = 'SquadsRpcError';
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
  /** Number of approvals collected so far. Defaults to 0 if field absent. */
  approved: number;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * NestJS injectable adapter for Squads V4 multisig RPC queries.
 *
 * All methods use dynamic `await import('@sqds/multisig')` to avoid CJS/ESM
 * interop failures (locked decision #8). The import is lazy — first call only.
 *
 * For tests: mock `SquadsRpcAdapter.getMultisigInfo` and
 * `SquadsRpcAdapter.getPendingTransactions` via vi.spyOn. The real SDK is
 * never loaded in unit tests because the methods are spied before invocation.
 */
@Injectable()
export class SquadsRpcAdapter {
  private readonly logger = new Logger(SquadsRpcAdapter.name);

  // Cached module references — populated on first use.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _multisig: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _web3: any = null;

  constructor(private readonly configService: ConfigService) {}

  // ---------------------------------------------------------------------------
  // Module loader helpers
  // ---------------------------------------------------------------------------

  /**
   * Lazy-load `@sqds/multisig`. Cached after first call.
   * Dynamic import is used to handle CJS/ESM interop safely (see IMPORT_STRATEGY).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async loadMultisig(): Promise<any> {
    if (!this._multisig) {
      this._multisig = await import('@sqds/multisig');
    }
    return this._multisig;
  }

  /**
   * Lazy-load `@solana/web3.js`. Cached after first call.
   * Dynamic import used for the same CJS/ESM interop reason as loadMultisig().
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async loadWeb3(): Promise<any> {
    if (!this._web3) {
      this._web3 = await import('@solana/web3.js');
    }
    return this._web3;
  }

  // ---------------------------------------------------------------------------
  // Config resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve the Squads multisig address from ConfigService.
   *
   * Reads `SQUADS_MULTISIG_ADDRESS`. SPEC §4 #6 — no process.env.
   *
   * @throws {SquadsAddressMissingError} if the env var is unset.
   */
  private resolveMultisigAddress(): string {
    // ADR-0026: per-field get via ConfigService.
    // The chain config carries the env-var key name; we read it using
    // getChain('solana').squads.multisigEnv to avoid hard-coding the key.
    const chainCfg = getChain('solana');
    if (!isSolana(chainCfg) || !chainCfg.squads) {
      throw new SquadsAddressMissingError();
    }
    const address = this.configService.get<string>(chainCfg.squads.multisigEnv);
    if (!address) throw new SquadsAddressMissingError();
    return address;
  }

  /**
   * Resolve the Solana RPC URL from ConfigService.
   *
   * Reads `RPC_SOL`. SPEC §4 #6 — no process.env.
   * The URL is never logged (may contain an API key in the path).
   *
   * @throws {SquadsRpcUrlMissingError} if the env var is unset.
   */
  private resolveRpcUrl(): string {
    const chainCfg = getChain('solana');
    if (!isSolana(chainCfg) || !chainCfg.squads) {
      throw new SquadsRpcUrlMissingError();
    }
    const url = this.configService.get<string>(chainCfg.squads.rpcEnv);
    if (!url) throw new SquadsRpcUrlMissingError();
    return url;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fetch Squads multisig member list and threshold.
   *
   * Calls `multisig.accounts.Multisig.fromAccountAddress` on the configured
   * `SQUADS_MULTISIG_ADDRESS`. Returns member public key strings (base58) and
   * the current threshold.
   *
   * A per-call Connection is created and discarded (locked decision OPEN-SDK-2).
   *
   * @param signal - Optional AbortSignal for wall-clock deadline. Not forwarded
   *   to individual RPC calls (the Squads SDK does not accept AbortSignal), but
   *   checked before each significant step. Callers should set a 30 s timeout.
   *
   * @throws {SquadsAddressMissingError} if SQUADS_MULTISIG_ADDRESS not set.
   * @throws {SquadsRpcUrlMissingError} if RPC_SOL not set.
   * @throws {SquadsRpcError} on RPC or Borsh decode failure.
   */
  async getMultisigInfo(signal?: AbortSignal): Promise<SquadsMultisigInfo> {
    const multisigAddress = this.resolveMultisigAddress();
    const rpcUrl = this.resolveRpcUrl();

    signal?.throwIfAborted();

    const [multisigMod, web3] = await Promise.all([this.loadMultisig(), this.loadWeb3()]);

    signal?.throwIfAborted();

    const multisigPda = new web3.PublicKey(multisigAddress);
    // Per-call Connection — not cached (locked decision OPEN-SDK-2).
    const connection = new web3.Connection(rpcUrl, 'confirmed');

    let multisigAccount: {
      threshold: number | bigint;
      members: Array<{ key: { toString(): string } }>;
    };
    try {
      multisigAccount = await multisigMod.accounts.Multisig.fromAccountAddress(connection, multisigPda);
    } catch (err) {
      // Do NOT include rpcUrl in the error message — it may contain an API key.
      throw new SquadsRpcError('getMultisigInfo', (err as Error).message);
    }

    const members = multisigAccount.members.map((m) => m.key.toString());
    const threshold = Number(multisigAccount.threshold);

    this.logger.debug(
      `squads-rpc: getMultisigInfo — address=${multisigAddress.slice(0, 8)}... members=${members.length} threshold=${threshold}`,
    );

    return { members, threshold };
  }

  /**
   * Fetch pending Active Squads transactions for the configured multisig.
   *
   * Scan window: latest 20 transaction indices descending from the current
   * `transactionIndex` on the multisig account (mirrors legacy
   * `scripts/check-squads-status.js:119-121`). Only proposals with
   * `status.__kind === 'Active'` are returned.
   *
   * Bounded limit: proposals beyond the 20-index window are not returned.
   * This matches legacy behaviour; if >20 proposals are queued simultaneously
   * some may be missed. Documented accepted limitation.
   *
   * Individual proposal fetch errors are logged as warnings and skipped (the
   * proposal may have been completed between the index read and the fetch).
   *
   * @param signal - Optional AbortSignal. Checked before the scan loop.
   *   Per-proposal fetch errors do NOT abort the scan.
   *
   * @throws {SquadsAddressMissingError} if SQUADS_MULTISIG_ADDRESS not set.
   * @throws {SquadsRpcUrlMissingError} if RPC_SOL not set.
   * @throws {SquadsRpcError} on multisig account fetch failure.
   */
  async getPendingTransactions(signal?: AbortSignal): Promise<SquadsPendingTransaction[]> {
    const multisigAddress = this.resolveMultisigAddress();
    const rpcUrl = this.resolveRpcUrl();

    signal?.throwIfAborted();

    const [multisigMod, web3] = await Promise.all([this.loadMultisig(), this.loadWeb3()]);

    signal?.throwIfAborted();

    const multisigPda = new web3.PublicKey(multisigAddress);
    // Per-call Connection — not cached (locked decision OPEN-SDK-2).
    const connection = new web3.Connection(rpcUrl, 'confirmed');

    // Fetch the multisig account to get the current transactionIndex.
    let multisigAccount: { transactionIndex: number | bigint };
    try {
      multisigAccount = await multisigMod.accounts.Multisig.fromAccountAddress(connection, multisigPda);
    } catch (err) {
      throw new SquadsRpcError('getPendingTransactions', (err as Error).message);
    }

    const txCount = Number(multisigAccount.transactionIndex);
    // Mirror legacy scan window: max(1, txCount - 19) to txCount descending.
    const startIdx = Math.max(1, txCount - 19);

    this.logger.debug(
      `squads-rpc: getPendingTransactions — address=${multisigAddress.slice(0, 8)}... scanning indices ${txCount}→${startIdx}`,
    );

    const pending: SquadsPendingTransaction[] = [];

    for (let i = txCount; i >= startIdx; i--) {
      // Check abort signal on each iteration so callers can cut the scan short.
      if (signal?.aborted) break;

      let proposalPda: { toString(): string };
      try {
        [proposalPda] = multisigMod.getProposalPda({
          multisigPda,
          transactionIndex: BigInt(i),
        });
      } catch (err) {
        this.logger.warn(`squads-rpc: getProposalPda failed for index ${i} — ${(err as Error).message}`);
        continue;
      }

      try {
        const proposal: {
          status: { __kind: string } | null | undefined;
          approved: unknown[] | null | undefined;
        } = await multisigMod.accounts.Proposal.fromAccountAddress(connection, proposalPda);

        if (proposal.status && proposal.status.__kind === 'Active') {
          pending.push({
            transactionIndex: i,
            // OPEN-SDK-1: nullable-or-default — default 0 if field absent.
            approved: proposal.approved?.length ?? 0,
          });
        }
      } catch (err) {
        // Proposal fetch can fail if the account doesn't exist yet or was
        // garbage-collected. Log and continue — this is normal for sparse indices.
        this.logger.warn(`squads-rpc: proposal fetch failed for index ${i} — ${(err as Error).message}`);
      }
    }

    this.logger.debug(`squads-rpc: getPendingTransactions — found ${pending.length} active proposals`);

    return pending;
  }
}
