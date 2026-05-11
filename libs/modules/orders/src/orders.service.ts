import { Injectable, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { OrdersRepository } from './orders.repository.js';
import { PaperExecutor } from './paper-executor.js';
import type { ProposeOrderDto } from './dto/propose-order.dto.js';
import type { ApproveOrderDto, RejectOrderDto, CancelOrderDto, RetryOrderDto } from './dto/order-state-change.dto.js';
import type { OrderListQueryDto } from './dto/order-list-query.dto.js';
import type { OrderResponseDto, OrderListResponseDto } from './dto/order-response.dto.js';
import type { ExecuteOrderAcceptedDto } from './dto/execute-order-response.dto.js';
import type { AppConfig } from '@cclaw/config';
import { ReceiptsService } from '@cclaw/receipts';

/** Name of the execute-order BullMQ queue (mirrors apps/worker/src/queues/execute-order.queue.ts). */
const EXECUTE_ORDER_QUEUE = 'execute-order';

/** Valid state transitions (migration 014 state machine). */
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['cancelled', 'executing', 'failed'],
  executing: ['executed', 'failed'],
  failed: ['approved', 'cancelled'], // retry re-approves; cancel from failed
};

/**
 * Orders service — domain logic and state machine (SPEC §5, migration 014).
 *
 * State machine:
 *   pending → approved (human or auto) → executing (P1c: executor spawns) → executed
 *   pending → rejected
 *   approved → cancelled
 *   executing/approved → failed → approved (retry) | cancelled
 *   pending → expired
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly repo: OrdersRepository,
    private readonly configSvc: ConfigService,
    @InjectQueue(EXECUTE_ORDER_QUEUE) private readonly executeQueue: Queue,
    private readonly receiptsService: ReceiptsService,
    private readonly paperExecutor: PaperExecutor,
  ) {}

  private get autoApproveBuy(): boolean {
    const cfg = this.configSvc.get<AppConfig>('') as AppConfig;
    return cfg?.AUTO_APPROVE_BUY ?? false;
  }

  private assertTransition(currentStatus: string, targetStatus: string): void {
    const allowed = VALID_TRANSITIONS[currentStatus] ?? [];
    if (!allowed.includes(targetStatus)) {
      throw new ConflictException(`Cannot transition order from '${currentStatus}' to '${targetStatus}'`);
    }
  }

  async list(query: OrderListQueryDto): Promise<OrderListResponseDto> {
    const limit = Math.min(query.limit ?? 50, 200);
    const [data, total] = await Promise.all([this.repo.findMany(query), this.repo.count(query)]);
    const lastId = data.length > 0 ? data[data.length - 1]?.id : undefined;
    return {
      data,
      pagination: { total, limit, cursor: lastId, hasMore: data.length === limit },
    };
  }

  async getById(id: string): Promise<OrderResponseDto> {
    return this.repo.findById(id);
  }

  async propose(dto: ProposeOrderDto): Promise<OrderResponseDto> {
    const order = await this.repo.create(dto);

    // Auto-approve BUY orders when flag is set (real mode only — paper mode
    // handles auto-approval separately through the executor path in P1c)
    if (dto.action === 'buy' && this.autoApproveBuy) {
      return this.repo.transitionStatus(order.id, 'approved', 'auto', undefined, {
        approvedAt: new Date().toISOString(),
        approvedBy: 'auto',
      });
    }

    return order;
  }

  async approve(id: string, dto: ApproveOrderDto): Promise<OrderResponseDto> {
    const order = await this.repo.findById(id);
    this.assertTransition(order.status, 'approved');
    const by = dto.by ?? 'human';
    return this.repo.transitionStatus(id, 'approved', by, dto.note, {
      approvedAt: new Date().toISOString(),
      approvedBy: by,
    });
  }

  async reject(id: string, dto: RejectOrderDto): Promise<OrderResponseDto> {
    const order = await this.repo.findById(id);
    this.assertTransition(order.status, 'rejected');
    return this.repo.transitionStatus(id, 'rejected', 'human', dto.reason);
  }

  async cancel(id: string, dto: CancelOrderDto): Promise<OrderResponseDto> {
    const order = await this.repo.findById(id);
    this.assertTransition(order.status, 'cancelled');
    return this.repo.transitionStatus(id, 'cancelled', 'human', dto.reason);
  }

  async retry(id: string, dto: RetryOrderDto): Promise<OrderResponseDto> {
    const order = await this.repo.findById(id);
    if (order.status !== 'failed') {
      throw new ConflictException(
        `Order ${id} cannot be retried from status '${order.status}' — only 'failed' orders can be retried`,
      );
    }
    const by = dto.by ?? 'human';
    // Retry brings the order back to 'approved' (ready for execution)
    return this.repo.transitionStatus(id, 'approved', by, 'retried', {
      approvedAt: new Date().toISOString(),
      approvedBy: by,
    });
  }

  /**
   * Execute an approved order.
   *
   * Paper mode (PAPER_MODE=true):
   *   - Transitions order: approved → executing → executed
   *   - Calls PaperExecutor.simulate() to produce a paper receipt
   *   - Writes paper receipt via ReceiptsService.create({mode:'paper'})
   *   - Returns {jobId: null, orderId, status: 'paper_executed'}
   *   - NO BullMQ enqueue
   *
   * Real mode (PAPER_MODE=false):
   *   - Transitions order: approved → executing
   *   - Enqueues BullMQ job with deterministic jobId = 'execute-order:<id>'
   *   - Returns {jobId, orderId, status: 'enqueued'}
   *   - Worker processes the job asynchronously
   *
   * @param id - Order ID from URL param.
   * @throws {ConflictException} if order is not in 'approved' status.
   */
  async execute(id: string): Promise<ExecuteOrderAcceptedDto> {
    const order = await this.repo.findById(id);

    // Validate: only 'approved' orders can be executed
    if (order.status !== 'approved') {
      throw new ConflictException(
        `Order ${id} cannot be executed from status '${order.status}' — only 'approved' orders can be executed`,
      );
    }

    const cfg = this.configSvc.get<AppConfig>('') as AppConfig;

    if (cfg.PAPER_MODE) {
      // -----------------------------------------------------------------------
      // Paper mode: short-circuit — simulate receipt, no executor spawn
      // -----------------------------------------------------------------------
      await this.repo.transitionStatus(id, 'executing', 'orders-service');

      // Simulate the trade
      const receiptDto = this.paperExecutor.simulate(order);
      await this.receiptsService.create(receiptDto);

      // Transition to executed
      await this.repo.transitionStatus(id, 'executed', 'orders-service');

      return { jobId: null, orderId: id, status: 'paper_executed' };
    }

    // -----------------------------------------------------------------------
    // Real mode: transition to executing + enqueue BullMQ job
    // -----------------------------------------------------------------------
    await this.repo.transitionStatus(id, 'executing', 'orders-service');

    // Deterministic jobId: duplicate adds collapse silently (idempotency)
    const jobId = `execute-order:${id}`;
    await this.executeQueue.add(
      'execute-order',
      { orderId: id },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: false,
      },
    );

    return { jobId, orderId: id, status: 'enqueued' };
  }
}
