/**
 * execute-order.processor.ts — BullMQ processor for execute-order jobs.
 *
 * Processes a single order execution request:
 *   1. Re-read order from DB (idempotency guard).
 *   2. Transition to 'executing'.
 *   3. Load signer env + spawn executor child.
 *   4. Parse receipt from child stdout.
 *   5. Write Receipt row via ReceiptsService.
 *   6. Transition order to 'executed' or 'failed'.
 *   7. Write service_audit row via AuditService.
 *
 * Concurrency: global 1 (ADR-0024). See apps/worker/src/app.module.ts for
 * the BullMQ worker concurrency option.
 *
 * Signer key isolation (ADR-0023, SPEC §4 #4):
 *   - Keys are loaded from SIGNER_ENV_FILE (default: /run/secrets/signer.env).
 *   - loadSignerEnv() reads the file; spawnExecutor() injects keys ONLY into
 *     the child env block. The worker's process.env is NEVER mutated.
 *
 * Audit convention (SPEC §9.5):
 *   - audit.path = 'worker:execute-order:<orderId>'
 *   - The 'worker:' prefix distinguishes these rows from HTTP audit entries
 *     so postmortems can filter: SELECT * FROM service_audit WHERE path LIKE 'worker:%'
 *
 * Error handling (ADR-0025):
 *   - On executor failure: emits structured 'executor_failed_alert' log line
 *     (log-only stub per ADR-0025; real Telegram wired in a later slice).
 *   - BullMQ retries the job up to 3x with exponential backoff before marking failed.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { loadSignerEnv, spawnExecutor, getExecutorPath } from '@cclaw/execution';
import type { OrderInput } from '@cclaw/execution';
import { OrdersRepository } from '@cclaw/orders';
import { ReceiptsService } from '@cclaw/receipts';
import { AuditService } from '@cclaw/audit';
import type { AppConfig } from '@cclaw/config';
import { EXECUTE_ORDER_QUEUE } from '../queues/execute-order.queue.js';

/** BullMQ job payload shape for execute-order jobs. */
export interface ExecuteOrderJobData {
  orderId: string;
}

/**
 * Error thrown when the processor finds a job already in-flight.
 * BullMQ will NOT retry this error (it indicates a programming bug).
 */
export class NotIdempotentInflightError extends Error {
  constructor(orderId: string) {
    super(`execute-order job for ${orderId} is already 'executing' — duplicate job?`);
    this.name = 'NotIdempotentInflightError';
  }
}

/**
 * BullMQ processor for the execute-order queue.
 *
 * Concurrency = 1 (global, per ADR-0024). P1c-ii MUST upgrade to per-Safe-address
 * groups when the real Safe/Squads SDK lands (see ADR-0024 for the derivation).
 *
 * @see apps/worker/src/app.module.ts for the BullModule.forRoot/forFeature wiring.
 */
@Processor(EXECUTE_ORDER_QUEUE, {
  // ADR-0024: global concurrency=1 in P1c-i. P1c-ii MUST replace with
  // per-Safe-address groups (group key = chain + ':' + safe_address, concurrency per group = 1).
  concurrency: 1,
})
@Injectable()
export class ExecuteOrderProcessor extends WorkerHost {
  private readonly logger = new Logger(ExecuteOrderProcessor.name);

  constructor(
    private readonly ordersRepo: OrdersRepository,
    private readonly receiptsService: ReceiptsService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<ExecuteOrderJobData>): Promise<void> {
    const { orderId } = job.data;
    const startMs = Date.now();
    const cfg = this.configService.get<AppConfig>('') as AppConfig;

    this.logger.log(`execute-order job started | orderId=${orderId} jobId=${job.id ?? 'n/a'}`);

    // ---------------------------------------------------------------------------
    // Step 1: idempotency guard — re-read order
    // ---------------------------------------------------------------------------
    const order = await this.ordersRepo.findById(orderId);

    if (order.status === 'executed') {
      this.logger.log(`execute-order: already executed, skipping (idempotent) | orderId=${orderId}`);
      return;
    }

    if (order.status === 'failed') {
      this.logger.log(`execute-order: already failed, skipping (idempotent) | orderId=${orderId}`);
      return;
    }

    if (order.status === 'executing') {
      // A second concurrent job is attempting to run — this should not happen
      // with concurrency=1 but could theoretically happen if a job was interrupted
      // and retried. Throw a non-retriable error.
      throw new NotIdempotentInflightError(orderId);
    }

    if (order.status !== 'approved') {
      this.logger.warn(`execute-order: unexpected status='${order.status}', skipping | orderId=${orderId}`);
      return;
    }

    // ---------------------------------------------------------------------------
    // Step 2: transition to 'executing'
    // ---------------------------------------------------------------------------
    await this.ordersRepo.transitionStatus(orderId, 'executing', 'WORKER');

    // ---------------------------------------------------------------------------
    // Step 3: load signer env + spawn executor
    // ---------------------------------------------------------------------------
    const signerEnvFile = cfg.SIGNER_ENV_FILE;
    let executorResult;

    try {
      const signerEnv = loadSignerEnv(signerEnvFile, cfg.NODE_ENV);
      const executorPath = getExecutorPath({ EXECUTOR_BIN_PATH: cfg.EXECUTOR_BIN_PATH });

      // Build OrderInput from order response DTO
      const orderInput: OrderInput = {
        id: order.id,
        action: order.action as 'buy' | 'sell',
        symbol: order.symbol,
        address: order.address,
        chain: order.chain,
        amount: order.amount,
        entry_price: order.entry_price ?? undefined,
        expected_amount_out: order.entry_price ?? undefined,
        slippage_bps: undefined, // No slippage_bps in OrderResponseDto — executor defaults apply
        tier: order.tier ?? undefined,
        stop_loss: order.stop_loss ?? undefined,
      };

      executorResult = await spawnExecutor(orderInput, {
        executorPath,
        signerEnv,
        timeoutMs: 120_000,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // ADR-0025: log-only stub; real Telegram alert wired in a later slice
      this.logger.error(`executor_failed_alert: spawn failed | orderId=${orderId} error=${message}`);
      await this.ordersRepo.transitionStatus(orderId, 'failed', 'WORKER', message);
      await this.writeAudit(orderId, order, 500, Date.now() - startMs, 'spawn_error');
      throw err;
    }

    // ---------------------------------------------------------------------------
    // Step 4: parse receipt and determine outcome
    // ---------------------------------------------------------------------------
    const { receipt, exitCode, latencyMs } = executorResult;
    const totalLatencyMs = Date.now() - startMs;

    if (!receipt || receipt.status === 'failed') {
      const errorMsg =
        receipt?.status === 'failed' ? receipt.error : `executor exited with code ${String(exitCode)} and no receipt`;
      const errorKind = receipt?.status === 'failed' ? receipt.error_kind : 'executor_no_receipt';

      // ADR-0025: log-only stub — structured line for postmortems; real Telegram in later slice
      this.logger.error(
        `executor_failed_alert | orderId=${orderId} chain=${order.chain} symbol=${order.symbol}` +
          ` latencyMs=${latencyMs} exitCode=${String(exitCode)} error_kind=${errorKind} error=${errorMsg}`,
      );

      await this.ordersRepo.transitionStatus(orderId, 'failed', 'WORKER', errorMsg);
      await this.writeAudit(orderId, order, 500, totalLatencyMs, errorKind);

      throw new Error(`executor failed for order ${orderId}: ${errorMsg}`);
    }

    // ---------------------------------------------------------------------------
    // Step 5: write Receipt row
    // ---------------------------------------------------------------------------
    const successReceipt = receipt; // status === 'executed'
    await this.receiptsService.create({
      order_id: orderId,
      action: order.action,
      symbol: order.symbol,
      address: order.address,
      chain: order.chain,
      status: 'executed',
      amount: parseFloat(order.amount),
      expected_price: order.entry_price ?? undefined,
      executed_price: successReceipt.actual_amount_out,
      slippage: successReceipt.slippage_bps / 100,
      onchain_tx_hash: successReceipt.tx_hash,
      gas_used: String(successReceipt.gas_used),
      notes: `block_number:${successReceipt.block_number}`,
      mode: 'real',
    });

    // ---------------------------------------------------------------------------
    // Step 6: transition order to 'executed'
    // ---------------------------------------------------------------------------
    await this.ordersRepo.transitionStatus(orderId, 'executed', 'WORKER');

    // ---------------------------------------------------------------------------
    // Step 7: write service_audit row
    // ---------------------------------------------------------------------------
    await this.writeAudit(orderId, order, 200, totalLatencyMs, undefined);

    this.logger.log(
      `execute-order done | orderId=${orderId} latencyMs=${totalLatencyMs} txHash=${successReceipt.tx_hash}`,
    );
  }

  /**
   * Write a service_audit row for this job.
   *
   * audit.path uses the 'worker:' prefix to distinguish from HTTP audit entries.
   * Convention: SELECT * FROM service_audit WHERE path LIKE 'worker:%' for postmortems.
   * @see AuditService.write — JSDoc for the 'worker:' prefix convention.
   */
  private async writeAudit(
    orderId: string,
    order: { action: string; chain: string },
    status: number,
    latencyMs: number,
    errorKind: string | undefined,
  ): Promise<void> {
    await this.auditService.write({
      ts: new Date().toISOString(),
      identity: 'WORKER',
      role: 'agent',
      method: 'JOB',
      // 'worker:' prefix distinguishes worker audit rows from HTTP audit rows (SPEC §9.5)
      path: `worker:execute-order:${orderId}`,
      body: { orderId, action: order.action, chain: order.chain },
      status,
      latencyMs,
      errorKind,
    });
  }
}
