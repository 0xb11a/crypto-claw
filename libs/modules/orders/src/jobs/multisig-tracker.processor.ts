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
 *      c. Solana (`queued_in_squads`): call `squadsRpc.getPendingTransactions()` once
 *         per cycle (batched, not per-receipt). Per OPEN-8: `safe_nonce` field stores
 *         the Squads transactionIndex — accepted overload.
 *      d. Confirmed+successful → `receiptsService.markExecuted`, position status update.
 *      e. Confirmed+failed → `receiptsService.markReverted`, cash refund for BUY rejection.
 *      f. Still pending → reminder gate (30 min interval, via `shouldSendReminder`).
 *   4. Always write `systemService.setMeta('last_multisig_tracker_at', now)`.
 *
 * Squads batch-fetch strategy:
 *   `getPendingTransactions()` is called at most once per cycle (when ≥1
 *   `queued_in_squads` receipts are present). The result is passed to
 *   `handleSquadsReceipt` for each receipt, avoiding N RPC calls for N receipts.
 *
 * Cross-module coordination:
 *   ReceiptsService → markExecuted / markReverted / updateNotes
 *   PositionsService → getById / update / deleteDraft
 *   SystemService → setCash / setMeta
 *   NotificationsService → sendTradeExecuted / sendTradeFailed
 *   SafeTxServiceAdapter → getTransaction (EVM)
 *   SquadsRpcAdapter → getPendingTransactions (Solana, SDK port complete)
 *
 * Idempotency (DoD §E):
 *   Running twice with the same receipt state leaves the DB identical (only
 *   `last_multisig_tracker_at` advances). markExecuted and markReverted are
 *   idempotent because Prisma update on a row that is already in the target
 *   state is a no-op (same field values). getPendingTransactions is read-only
 *   and side-effect-free.
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
import { SquadsRpcAdapter, SquadsAddressMissingError, SquadsRpcError } from '@cclaw/adapters-squads-rpc';
import type { SquadsPendingTransaction } from '@cclaw/adapters-squads-rpc';
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
    private readonly squadsRpc: SquadsRpcAdapter,
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

    // Batch-fetch Squads pending transactions once per cycle if any Squads receipts exist.
    // This avoids N RPC calls for N receipts — one call feeds all handleSquadsReceipt calls.
    let squadsPending: SquadsPendingTransaction[] | null = null;

    const hasSquadsReceipts = receipts.some((r) => r.status === 'queued_in_squads');
    if (hasSquadsReceipts) {
      try {
        const signal = AbortSignal.timeout(30_000);
        squadsPending = await this.squadsRpc.getPendingTransactions(signal);
        this.logger.debug(`multisig-tracker: Squads pending count=${squadsPending.length}`);
      } catch (err) {
        if (err instanceof SquadsAddressMissingError) {
          // No multisig address configured — log debug and skip Squads receipts this cycle.
          this.logger.debug(`multisig-tracker: Squads address missing — ${(err as Error).message}`);
        } else if (err instanceof SquadsRpcError) {
          // RPC error (network, Borsh decode). Do NOT include RPC URL in log.
          this.logger.warn(`multisig-tracker: Squads RPC error — ${(err as Error).message}`);
        } else {
          this.logger.warn(`multisig-tracker: Squads getPendingTransactions error — ${(err as Error).message}`);
        }
        // squadsPending remains null; Squads receipts will be counted as pending this cycle.
      }
    }

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
          if (squadsPending === null) {
            // Squads fetch failed this cycle — treat as pending (retry next cycle).
            this.logger.debug(
              `multisig-tracker: Squads fetch unavailable this cycle — receipt ${receiptId} stays pending`,
            );
            counts.pending++;
          } else {
            await this.handleSquadsReceipt(receiptSubset, positionSubset, squadsPending, counts);
          }
        }
      } catch (err) {
        this.logger.warn(`multisig-tracker: error processing receipt ${receiptId} — ${(err as Error).message}`);
        counts.pending++;
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
   * Decision logic (mirrors legacy `scripts/track-multisig.js:checkSquadsTransaction`):
   *   - If the transactionIndex is present in `squadsPending` → still pending.
   *   - If absent from `squadsPending` → assumed executed (Squads removes on execution).
   *   - If txIndex is missing from the receipt → treated as pending (skip + warn).
   *
   * Note: Squads does not provide an on-chain failure/rejection signal in the
   * pending list — a rejected/cancelled proposal also disappears. The current
   * behaviour (treat absent as executed) is a deliberate legacy-parity choice;
   * handling the cancellation case requires a separate Squads SDK call and is
   * deferred to a follow-up PR.
   *
   * @internal
   */
  private async handleSquadsReceipt(
    receipt: { id: string; safe_nonce?: number; symbol: string; notes?: string },
    position: { id: string; status: string; chain: string; value_usd?: number },
    squadsPending: SquadsPendingTransaction[],
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
