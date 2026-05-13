import { Module, DynamicModule } from '@nestjs/common';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { OrdersRepository } from './orders.repository.js';
import { PaperExecutor } from './paper-executor.js';
import { QueueResolver, CHAIN_QUEUE_MAP } from './queue-resolver.js';
import { ReceiptsModule } from '@cclaw/receipts';

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
}
