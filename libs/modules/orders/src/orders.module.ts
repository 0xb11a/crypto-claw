import { Module, DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { OrdersRepository } from './orders.repository.js';
import { PaperExecutor } from './paper-executor.js';
import { QueueResolver, CHAIN_QUEUE_MAP } from './queue-resolver.js';
import { ReceiptsModule } from '@cclaw/receipts';
import { PositionsModule } from '@cclaw/positions';
import { SystemModule } from '@cclaw/system';
import { NotificationsModule } from '@cclaw/notifications';
import { SafeTxServiceModule } from '@cclaw/adapters-safe-tx-service';
import { SquadsRpcModule } from '@cclaw/adapters-squads-rpc';
import { MultisigTrackerProcessor } from './jobs/multisig-tracker.processor.js';
import { ApprovalBotService } from './jobs/approval-bot.service.js';
import { MULTISIG_TRACKING_QUEUE, MULTISIG_TRACKING_JOB_OPTIONS } from './queue-names.js';

/**
 * Options for `OrdersModule.forRoot()`.
 */
export interface OrdersModuleOptions {
  /** Map of chain name → BullMQ queue name, built by `buildChainQueueMap()`. */
  chainQueueMap: Map<string, string>;
}

/**
 * Orders module — wires controller, service, repository, and execution deps.
 *
 * Usage in app modules (apps/api, apps/worker):
 *
 *   OrdersModule.forRoot({ chainQueueMap })
 *
 * `forRoot()` injects the `CHAIN_QUEUE_MAP` token into `QueueResolver` so it
 * can route enqueues to the correct per-Safe BullMQ queue at runtime.
 *
 * The bare `OrdersModule` (without `forRoot`) is intentionally kept parseable
 * for test scaffolding — callers that don't need real queue routing can provide
 * a stub `CHAIN_QUEUE_MAP` directly in their `TestingModule`.
 *
 * P1c-ii changes:
 *   - Converted from static @Module to forRoot() DynamicModule so that
 *     CHAIN_QUEUE_MAP is owned by this module rather than the app-level module.
 *     Cross-module DI of a non-exported provider fails in NestJS; the forRoot
 *     pattern is the canonical fix (ADR-0024 addendum, P1c-ii blocker).
 *   - Removed standalone BullModule.registerQueue('execute-order') — queues are
 *     registered by app modules using `resolveActiveQueueNames()` (ADR-0024).
 *
 * PrismaModule is global, so PrismaService is injected automatically.
 * BullMQ connection (BullModule.forRoot) is set up by the importing app module.
 */
@Module({})
export class OrdersModule {
  /**
   * Configure the OrdersModule with a runtime chain→queue map.
   *
   * Call this in every app module that imports OrdersModule:
   *   `OrdersModule.forRoot({ chainQueueMap })`
   *
   * @param opts.chainQueueMap - Output of `buildChainQueueMap(activeChains, process.env)`.
   */
  static forRoot(opts: OrdersModuleOptions): DynamicModule {
    return {
      module: OrdersModule,
      imports: [ReceiptsModule],
      controllers: [OrdersController],
      providers: [
        // Provide the chain→queue map as the CHAIN_QUEUE_MAP injection token.
        // QueueResolver consumes this token to route enqueues at runtime.
        {
          provide: CHAIN_QUEUE_MAP,
          useValue: opts.chainQueueMap,
        },
        OrdersService,
        OrdersRepository,
        PaperExecutor,
        QueueResolver,
      ],
      exports: [OrdersService, OrdersRepository, QueueResolver],
    };
  }

  /**
   * Worker-side factory — registers the multisig-tracking BullMQ processor
   * and the continuous approval-bot service (ADR-0027).
   *
   * Does NOT register HTTP controllers (those are on `forRoot()`).
   * The MULTISIG_TRACKING_QUEUE is registered here (not in apps/worker) so
   * the `@Processor(MULTISIG_TRACKING_QUEUE)` in MultisigTrackerProcessor
   * resolves correctly within this module's context.
   *
   * ApprovalBotService has no BullMQ queue — it is a continuous long-poll
   * worker (ADR-0027 Continuous-Worker pattern). It is registered here because
   * it owns order-state transitions on the orders table, which is this module's
   * domain.
   *
   * Imports ReceiptsModule, PositionsModule, SystemModule, NotificationsModule,
   * SafeTxServiceModule, SquadsRpcModule so the processor resolves all its deps.
   *
   * This is additive to `forRoot()` — apps/worker registers both if it needs
   * both the execute-order queue routing and the multisig tracker.
   */
  static forWorker(): DynamicModule {
    return {
      module: OrdersModule,
      imports: [
        BullModule.registerQueue({
          name: MULTISIG_TRACKING_QUEUE,
          defaultJobOptions: { ...MULTISIG_TRACKING_JOB_OPTIONS },
        }),
        ReceiptsModule,
        PositionsModule,
        SystemModule,
        NotificationsModule,
        SafeTxServiceModule,
        SquadsRpcModule,
      ],
      providers: [
        MultisigTrackerProcessor,
        // P3g3 PR-F: continuous long-poll worker (ADR-0027 — no BullMQ queue).
        // OrdersRepository must be re-declared here. NestJS DynamicModule merge
        // behavior does NOT share providers across `forRoot()` + `forWorker()`
        // calls in our @nestjs/common version (verified via worker boot smoke).
        // Re-declaring the provider in both factories is the established pattern
        // (mirrors WalletsModule.forWorker() in PR-A which lists WalletsRepository
        // explicitly). Both DynamicModule instances produce distinct providers
        // bound to the same class token; the injector resolves consistently.
        //
        // TelegramAdapter is available via NotificationsModule (imported above).
        // SystemService is available via SystemModule (imported above).
        OrdersRepository,
        ApprovalBotService,
      ],
      exports: [],
    };
  }
}
