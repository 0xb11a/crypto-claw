/**
 * multisig-tracker.processor.ts — BullMQ processor for multisig-tracking jobs.
 *
 * Ports the `scripts/track-multisig.js` background loop into a standalone,
 * idempotent NestJS processor.
 *
 * Per-cycle algorithm (legacy parity — DoD §I):
 *   1. Skip if `PAPER_MODE === true` (parity with `entrypoint.sh:863`).
 *   2. `receiptsService.findByStatuses(['queued_in_safe','queued_in_squads'])`.
 *   3. Per receipt:
 *      a. Load position via `positionsService.getById(position_id)`.
 *         If orphaned → `receiptsService.markReverted(id, 'orphaned_position')`.
 *      b. EVM (`queued_in_safe`): `safeTxService.getTransaction(chain, safe_tx_hash)`.
 *      c. Solana (`queued_in_squads`): feature-flag skipped (SquadsRpcAdapter SDK port pending).
 *         Receipt stays in `queued_in_squads` for scripts/track-multisig.js to handle.
 *         Per OPEN-8: `safe_nonce` field stores the Squads transactionIndex — accepted overload.
 *      d. Confirmed+successful → `receiptsService.markExecuted`, position status update.
 *      e. Confirmed+failed → `receiptsService.markReverted`, cash refund for BUY rejection.
 *      f. Still pending → reminder gate (30 min interval, via `shouldSendReminder`).
 *   4. Always write `systemService.setMeta('last_multisig_tracker_at', now)`.
 *
 * Cross-module coordination:
 *   ReceiptsService → markExecuted / markReverted / updateNotes
 *   PositionsService → getById / update / deleteDraft
 *   SystemService → setCash / setMeta
 *   NotificationsService → sendTradeExecuted / sendTradeFailed
 *   SafeTxServiceAdapter → getTransaction (EVM)
 *   SquadsRpcAdapter → Solana path feature-flag skipped (SDK port pending);
 *     receipts in `queued_in_squads` remain handled by scripts/track-multisig.js
 *     via entrypoint.sh:run_executor_loop until a dedicated PR lands.
 *
 * Idempotency (DoD §E):
 *   Running twice with the same receipt state leaves the DB identical (only
 *   `last_multisig_tracker_at` advances). markExecuted and markReverted are
 *   idempotent because Prisma update on a row that is already in the target
 *   state is a no-op (same field values).
 *
 * Config access (ADR-0026 — per-field):
 *   - `PAPER_MODE`
 *
 * SPEC §4 #4: no signer-key env vars read here.
 * SPEC §4 #6: no process.env reads — all config via ConfigService.
 */
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { SafeTxServiceAdapter } from '@cclaw/adapters-safe-tx-service';
import { SquadsRpcAdapter, SquadsRpcNotImplementedError } from '@cclaw/adapters-squads-rpc';
import { NotificationsService } from '@cclaw/notifications';
import { SystemService } from '@cclaw/system';
import { PositionsService } from '@cclaw/positions';
import { ReceiptsService } from '@cclaw/receipts';
import { MULTISIG_TRACKING_QUEUE } from '../queue-names.js';
import { shouldSendReminder, buildReminderNotes } from './reminder-notes.js';

/** BullMQ job payload — empty (all config resolved via ConfigService). */
export type MultisigTrackerJobData = Record<string, never>;

/** Structured return value surfaced in BullMQ job result for observability. */
export interface MultisigTrackerResult {
  checked: number;
  confirmed: number;
  pending: number;
  failed: number;
  skipped: boolean;
}

/**
 * BullMQ processor for multisig-tracking jobs.
 *
 * Job topology (P3g2 plan, Queue topology):
 *   Queue: `multisig-tracking` — global singleton, not per-Safe.
 *   Concurrency: 1 — one in-flight cycle at a time (legacy parity).
 *   Retry: 2 attempts, 60 s fixed backoff.
 */
@Processor(MULTISIG_TRACKING_QUEUE, { concurrency: 1 })
export class MultisigTrackerProcessor extends WorkerHost {
  private readonly logger = new Logger(MultisigTrackerProcessor.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly receiptsService: ReceiptsService,
    private readonly positionsService: PositionsService,
    private readonly systemService: SystemService,
    private readonly notificationsService: NotificationsService,
    private readonly safeTxService: SafeTxServiceAdapter,
    // squadsRpc retained in DI graph so the module stays wired when the SDK
    // port PR re-enables the Solana path. Solana tracking is currently handled
    // by entrypoint.sh:run_executor_loop (scripts/track-multisig.js).
    private readonly _squadsRpc: SquadsRpcAdapter,
  ) {
    super();
  }

  async process(job: Job<MultisigTrackerJobData>): Promise<MultisigTrackerResult> {
    this.logger.log(`multisig-tracker: starting job ${job.id}`);

    // Skip in paper mode — multisig tracking is real-mode only.
    const paperMode = this.configService.get<boolean>('PAPER_MODE');
    if (paperMode) {
      this.logger.log('multisig-tracker: PAPER_MODE=true — skipping cycle');
      return { checked: 0, confirmed: 0, pending: 0, failed: 0, skipped: true };
    }

    const counts = { checked: 0, confirmed: 0, pending: 0, failed: 0 };

    // Find all pending multisig receipts.
    const receipts = await this.receiptsService.findByStatuses(['queued_in_safe', 'queued_in_squads']);
    counts.checked = receipts.length;

    if (receipts.length === 0) {
      this.logger.debug('multisig-tracker: no queued receipts found');
    }

    // Solana multisig tracking feature-flag: SquadsRpcAdapter is a stub that
    // throws SquadsRpcNotImplementedError. Solana receipts are intentionally
    // skipped here and remain handled by entrypoint.sh:run_executor_loop via
    // scripts/track-multisig.js until a dedicated SDK-port PR lands.
    // See libs/adapters/squads-rpc/src/squads-rpc.adapter.ts for rationale.
    let solanaSkipWarned = false;

    for (const receipt of receipts) {
      const receiptId = receipt.id;

      // Load the linked position.
      if (!receipt.position_id) {
        this.logger.warn(`multisig-tracker: receipt ${receiptId} has no position_id — marking reverted`);
        await this.receiptsService.markReverted(receiptId, 'orphaned_position');
        counts.failed++;
        continue;
      }

      const positionId = receipt.position_id;
      let position: Awaited<ReturnType<typeof this.positionsService.getById>> | null = null;
      try {
        position = await this.positionsService.getById(positionId, 'real');
      } catch {
        // Position was deleted — orphaned receipt.
        this.logger.error(`multisig-tracker: receipt ${receiptId} position ${positionId} not found — marking reverted`);
        await this.receiptsService.markReverted(receiptId, 'orphaned_position');
        counts.failed++;
        continue;
      }

      try {
        // Build typed subset for handlers (normalises null→undefined for strict types).
        const receiptSubset = {
          id: receipt.id,
          chain: receipt.chain,
          safe_tx_hash: receipt.safe_tx_hash ?? undefined,
          safe_nonce: receipt.safe_nonce ?? undefined,
          symbol: receipt.symbol,
          notes: receipt.notes ?? undefined,
        };

        // Normalise position — null value_usd → undefined for strict handler types.
        const positionSubset = {
          id: position.id,
          status: position.status,
          chain: position.chain,
          value_usd: position.value_usd ?? undefined,
        };

        if (receipt.status === 'queued_in_safe') {
          await this.handleSafeReceipt(receiptSubset, positionSubset, counts);
        } else if (receipt.status === 'queued_in_squads') {
          /**
           * FEATURE FLAG — Solana tracking deferred to legacy script.
           *
           * SquadsRpcAdapter.getPendingTransactions() throws
           * SquadsRpcNotImplementedError (SDK port pending). This branch
           * explicitly skips Solana receipts so they remain handled by
           * entrypoint.sh:run_executor_loop → scripts/track-multisig.js until
           * a dedicated PR adds @sqds/multisig with real fixture validation.
           *
           * The receipt is NOT touched (no status transition, no markExecuted,
           * no markReverted). It stays in `queued_in_squads` for the legacy
           * loop to process. A single warn is emitted per cycle (not per receipt)
           * to avoid log spam.
           */
          if (!solanaSkipWarned) {
            this.logger.warn(
              'multisig-tracker: Solana multisig tracking deferred to ' +
                'entrypoint.sh:run_executor_loop; SquadsRpcAdapter SDK port pending',
            );
            solanaSkipWarned = true;
          }
          this.logger.debug(
            `multisig-tracker: skipping queued_in_squads receipt ${receiptId} — handled by scripts/track-multisig.js`,
          );
          counts.pending++;
        }
      } catch (err) {
        // Defense-in-depth: if SquadsRpcNotImplementedError somehow escapes the
        // explicit skip above (e.g. after a future refactor accidentally re-enables
        // the adapter call), log loudly rather than silently swallowing bad data.
        if (err instanceof SquadsRpcNotImplementedError) {
          this.logger.error(
            `multisig-tracker: SquadsRpcNotImplementedError reached unexpectedly for receipt ${receiptId} — ` +
              'Solana tracking must remain in entrypoint.sh:run_executor_loop until SDK port lands',
          );
          counts.pending++;
        } else {
          this.logger.warn(`multisig-tracker: error processing receipt ${receiptId} — ${(err as Error).message}`);
          counts.pending++;
        }
      }
    }

    // Always advance health meta key.
    const now = new Date().toISOString();
    await this.systemService.setMeta({ key: 'last_multisig_tracker_at', value: now });

    const result: MultisigTrackerResult = { ...counts, skipped: false };
    this.logger.log(
      `multisig-tracker: done — checked=${counts.checked} confirmed=${counts.confirmed} pending=${counts.pending} failed=${counts.failed}`,
    );
    return result;
  }

  /**
   * Handle a receipt queued in an EVM Safe multisig.
   *
   * @internal
   */
  private async handleSafeReceipt(
    receipt: { id: string; chain: string; safe_tx_hash?: string; symbol: string; notes?: string },
    position: { id: string; status: string; chain: string; value_usd?: number },
    counts: { confirmed: number; pending: number; failed: number },
  ): Promise<void> {
    if (!receipt.safe_tx_hash) {
      this.logger.warn(`multisig-tracker: receipt ${receipt.id} missing safe_tx_hash — skipping`);
      counts.pending++;
      return;
    }

    let txResult: Awaited<ReturnType<typeof this.safeTxService.getTransaction>> | null = null;
    try {
      txResult = await this.safeTxService.getTransaction(
        receipt.chain,
        receipt.safe_tx_hash,
        AbortSignal.timeout(30_000),
      );
    } catch (err) {
      this.logger.warn(`multisig-tracker: EVM status check failed for ${receipt.id} — ${(err as Error).message}`);
      counts.pending++;
      return;
    }

    if (txResult.executed && txResult.isSuccessful) {
      await this.handleConfirmed(receipt, position, txResult.txHash);
      counts.confirmed++;
    } else if (txResult.executed && !txResult.isSuccessful) {
      await this.handleRejected(receipt, position);
      counts.failed++;
    } else {
      await this.handlePending(receipt);
      counts.pending++;
    }
  }

  /**
   * Handle a receipt queued in a Squads multisig.
   *
   * OPEN-8: `receipt.safe_nonce` stores the Squads transactionIndex (deliberate overload).
   *
   * @internal
   */
  private async handleSquadsReceipt(
    receipt: { id: string; safe_nonce?: number; symbol: string; notes?: string },
    position: { id: string; status: string; chain: string; value_usd?: number },
    squadsPending: { transactionIndex: number; approved: number }[],
    counts: { confirmed: number; pending: number; failed: number },
  ): Promise<void> {
    const txIndex = receipt.safe_nonce;
    if (txIndex == null) {
      this.logger.warn(`multisig-tracker: receipt ${receipt.id} missing txIndex (safe_nonce) — skipping`);
      counts.pending++;
      return;
    }

    // If the transaction is in the pending list → still pending.
    // If not in the pending list → assumed executed (Squads removes on execution).
    const found = squadsPending.find((t) => t.transactionIndex === txIndex);

    if (found) {
      // Still pending — check reminder gate.
      await this.handlePending({ id: receipt.id, symbol: receipt.symbol, notes: receipt.notes });
      counts.pending++;
    } else {
      // Not in pending list → executed (or cancelled — treat as confirmed for now).
      // For Squads, we don't have a chain on the receipt subset; read it from position.
      await this.handleConfirmed({ id: receipt.id, chain: position.chain, symbol: receipt.symbol }, position, null);
      counts.confirmed++;
    }
  }

  /**
   * Handle a confirmed + successful transaction.
   *
   * Bug-for-bug port of `scripts/track-multisig.js:handleConfirmed`.
   *
   * @internal
   */
  private async handleConfirmed(
    receipt: { id: string; chain: string; symbol: string },
    position: { id: string; status: string; chain: string; value_usd?: number },
    onchainTxHash: string | null,
  ): Promise<void> {
    await this.receiptsService.markExecuted(receipt.id, onchainTxHash);

    if (position.status === 'draft') {
      // BUY confirmed: activate position.
      await this.positionsService.update(position.id, { status: 'open' }, 'real');
      this.logger.log(`multisig-tracker: BUY confirmed — position ${position.id} → open`);
      await this.notificationsService.sendTradeExecuted(
        'tracker',
        `Multisig confirmed: BUY $${receipt.symbol} — position activated`,
      );
    } else if (position.status === 'pending_exit') {
      // SELL confirmed: close position.
      await this.positionsService.update(position.id, { status: 'closed' }, 'real');
      this.logger.log(`multisig-tracker: SELL confirmed — position ${position.id} → closed`);
      await this.notificationsService.sendTradeExecuted(
        'tracker',
        `Multisig confirmed: SELL $${receipt.symbol} — position closed`,
      );
    }

    // OPEN-7: mark portfolio sync stale instead of inline portfolio-load.
    await this.systemService.setMeta({ key: 'last_portfolio_sync_stale_at', value: new Date().toISOString() });
  }

  /**
   * Handle a rejected / on-chain-failed transaction.
   *
   * Bug-for-bug port of `scripts/track-multisig.js:handleRejected`.
   *
   * @internal
   */
  private async handleRejected(
    receipt: { id: string; chain: string; symbol: string },
    position: { id: string; status: string; chain: string; value_usd?: number },
  ): Promise<void> {
    await this.receiptsService.markReverted(receipt.id);

    if (position.status === 'draft') {
      // BUY rejected: delete draft position, refund cash.
      const cashRow = await this.systemService.getCashByChain(position.chain);
      const currentCash = cashRow.cash ?? 0;
      const refund = position.value_usd ?? 0;
      await this.systemService.setCash({ chain: position.chain, amount: currentCash + refund });
      await this.positionsService.deleteDraft(position.id);
      this.logger.log(`multisig-tracker: BUY rejected — draft ${position.id} deleted, cash refunded ${refund}`);
      await this.notificationsService.sendTradeFailed(
        'tracker',
        `Multisig rejected: BUY $${receipt.symbol} — draft reverted, cash refunded`,
      );
    } else if (position.status === 'pending_exit') {
      // SELL rejected: revert position to open.
      await this.positionsService.update(position.id, { status: 'open' }, 'real');
      this.logger.log(`multisig-tracker: SELL rejected — position ${position.id} → open`);
      await this.notificationsService.sendTradeFailed(
        'tracker',
        `Multisig rejected: SELL $${receipt.symbol} — position reopened`,
      );
    }
  }

  /**
   * Handle a still-pending transaction — send a reminder if the interval has elapsed.
   *
   * Bug-for-bug port of `scripts/track-multisig.js:handlePending`.
   *
   * @internal
   */
  private async handlePending(receipt: { id: string; symbol: string; notes?: string }): Promise<void> {
    const now = Date.now();
    if (shouldSendReminder(receipt.notes, now)) {
      const updatedNotes = buildReminderNotes(receipt.notes, now);
      await this.receiptsService.updateNotes(receipt.id, updatedNotes);
      this.logger.log(`multisig-tracker: reminder for ${receipt.id} $${receipt.symbol}`);
      await this.notificationsService.sendCriticalAlert({
        type: 'system_health',
        agent: 'tracker',
        message: `Multisig tx still pending: $${receipt.symbol} (receipt: ${receipt.id})`,
      });
    }
  }
}
