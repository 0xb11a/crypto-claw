/**
 * execute-order.processor.ts — BullMQ processor for execute-order jobs.
 *
 * Processes a single order execution request:
 *   1. Re-read order from DB (idempotency guard).
 *   2. Load signer env + spawn executor child.
 *   3. Parse receipt from child stdout.
 *   4. Write Receipt row via ReceiptsService.
 *   5. Transition order to 'executed' or 'failed'.
 *   6. Write service_audit row via AuditService.
 *
 * State machine contract (orders.service.ts owns approved→executing):
 *   The API layer transitions the order from 'approved' to 'executing' BEFORE
 *   the BullMQ job is enqueued (orders.service.ts:181).  This achieves
 *   synchronous idempotency: a second concurrent POST /execute is rejected with
 *   409 because the order is already 'executing', not 'approved'.
 *
 *   As a result the processor ALWAYS receives orders in 'executing' status.
 *   It does NOT call transitionStatus(orderId, 'executing') — that would be
 *   a no-op at best and a state-machine bug at worst.
 *
 *   Valid processor entry states:
 *     'executing' → proceed to spawn executor (normal path)
 *     'executed'  → skip (idempotent, job was replayed)
 *     'failed'    → skip (idempotent, job was replayed after terminal failure)
 *     anything else → log warning and skip (unexpected; api bug upstream)
 *
 * Concurrency (ADR-0024 addendum, P1c-ii):
 *   Per-Safe queue topology — one Worker per queue, concurrency=1 per queue.
 *   Cross-queue parallelism is unbounded. `createExecuteOrderProcessor(queueName)`
 *   is called once per active (chain, safeAddress) pair in app.module.ts.
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
 *
 * Config access (ADR-0026):
 *   - Uses per-field configService.get<T>('FIELD') — not bare-key get<AppConfig>('').
 *   - Boolean fields use === 'true' string-normalisation (Zod preserves raw string).
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { loadSignerEnv, spawnExecutor, getExecutorPath } from '@cclaw/execution';
import type { OrderInput } from '@cclaw/execution';
import { OrdersRepository } from '@cclaw/orders';
import { ReceiptsService } from '@cclaw/receipts';
import { AuditService } from '@cclaw/audit';

/** BullMQ job payload shape for execute-order jobs. */
export interface ExecuteOrderJobData {
  orderId: string;
}

/**
 * Error retained for backwards compatibility with the test suite.
 *
 * This error is NO LONGER thrown by the processor in normal operation.
 * The api owns the approved→executing transition; the processor expects
 * to receive orders already in 'executing' status.  'executing' is now
 * the happy-path entry state, not a duplicate-job signal.
 *
 * @deprecated Kept only so existing test imports do not break.  Will be
 *   removed once the test suite is fully migrated.
 */
export class NotIdempotentInflightError extends Error {
  constructor(orderId: string) {
    super(`execute-order job for ${orderId} is already 'executing' — duplicate job?`);
    this.name = 'NotIdempotentInflightError';
  }
}

/**
 * Base class holding all execute-order processing logic.
 *
 * This class is NOT decorated with @Processor — the per-queue decorator is
 * applied by the `createExecuteOrderProcessor` factory below.  Splitting the
 * logic from the decorator allows the same implementation to be reused across
 * multiple queue-name-specific subclasses (one per active Safe).
 */
export abstract class BaseExecuteOrderProcessor extends WorkerHost {
  protected readonly logger = new Logger('ExecuteOrderProcessor');

  constructor(
    protected readonly ordersRepo: OrdersRepository,
    protected readonly receiptsService: ReceiptsService,
    protected readonly auditService: AuditService,
    protected readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<ExecuteOrderJobData>): Promise<void> {
    const { orderId } = job.data;
    const startMs = Date.now();

    // ADR-0026: per-field gets — not bare-key get<AppConfig>('')
    const signerEnvFile = this.configService.get<string>('SIGNER_ENV_FILE') ?? '/run/secrets/signer.env';
    const executorBinPath = this.configService.get<string>('EXECUTOR_BIN_PATH');
    const nodeEnv = this.configService.get<string>('NODE_ENV') ?? 'production';

    this.logger.log(`execute-order job started | orderId=${orderId} jobId=${job.id ?? 'n/a'}`);

    // ---------------------------------------------------------------------------
    // Step 1: idempotency guard — re-read order
    //
    // The API layer already transitioned approved → executing before enqueueing.
    // Valid entry states:
    //   'executing' — normal path; proceed to spawn
    //   'executed'  — idempotent replay; skip
    //   'failed'    — idempotent replay after terminal failure; skip
    //   anything else — unexpected (api bug); log and skip
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

    if (order.status !== 'executing') {
      // Any status other than 'executing' at this point is unexpected.
      // The API should have transitioned approved→executing before enqueueing.
      // Log and skip rather than throw, so BullMQ does not retry endlessly.
      this.logger.warn(
        `execute-order: unexpected status='${order.status}', expected 'executing' — skipping | orderId=${orderId}`,
      );
      return;
    }

    // order.status === 'executing' — proceed to spawn executor

    // ---------------------------------------------------------------------------
    // Step 2: load signer env + spawn executor
    // ---------------------------------------------------------------------------
    let executorResult;

    try {
      const signerEnv = loadSignerEnv(signerEnvFile, nodeEnv);
      const executorPath = getExecutorPath({ EXECUTOR_BIN_PATH: executorBinPath });

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
    // Step 3: parse receipt and determine outcome
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
    // Step 4: write Receipt row
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
    // Step 5: transition order to 'executed'
    // ---------------------------------------------------------------------------
    await this.ordersRepo.transitionStatus(orderId, 'executed', 'WORKER');

    // ---------------------------------------------------------------------------
    // Step 6: write service_audit row
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

/**
 * Factory that creates an execute-order processor for a specific BullMQ queue.
 *
 * Returns a class decorated with `@Processor(queueName)` and `@Injectable()`.
 * Each returned class processes jobs from exactly one queue with concurrency=1,
 * enforcing per-Safe nonce-collision protection (ADR-0024 addendum).
 *
 * Usage in app.module.ts:
 * ```ts
 * const processors = activeQueueNames.map(createExecuteOrderProcessor);
 * @Module({ providers: [...processors] })
 * ```
 *
 * @param queueName - The BullMQ queue name, e.g. 'execute-order-base-0xabc'.
 * @returns A NestJS provider class for the given queue.
 */
export function createExecuteOrderProcessor(queueName: string): Type<BaseExecuteOrderProcessor> {
  @Processor(queueName, {
    // concurrency=1 per queue — prevents nonce collisions for the same Safe (ADR-0024)
    concurrency: 1,
  })
  @Injectable()
  class ExecuteOrderProcessorForQueue extends BaseExecuteOrderProcessor {
    constructor(
      ordersRepo: OrdersRepository,
      receiptsService: ReceiptsService,
      auditService: AuditService,
      configService: ConfigService,
    ) {
      super(ordersRepo, receiptsService, auditService, configService);
    }
  }
  return ExecuteOrderProcessorForQueue;
}

/**
 * Concrete processor class for the legacy single queue name.
 *
 * Kept for backwards compatibility with the P1c-i spec:
 *   - Unit tests (`execute-order.processor.spec.ts`) reference `ExecuteOrderProcessor`.
 *   - The @Processor decorator is applied at class definition time so it cannot be
 *     parameterised by a runtime variable — the factory pattern above is used for
 *     per-Safe queues, and this concrete class covers the legacy path.
 *
 * @deprecated App modules should use `createExecuteOrderProcessor(queueName)` instead.
 *   This class is retained until the test suite migrates to the factory pattern.
 */
@Processor('execute-order', { concurrency: 1 })
@Injectable()
export class ExecuteOrderProcessor extends BaseExecuteOrderProcessor {
  constructor(
    ordersRepo: OrdersRepository,
    receiptsService: ReceiptsService,
    auditService: AuditService,
    configService: ConfigService,
  ) {
    super(ordersRepo, receiptsService, auditService, configService);
  }
}
