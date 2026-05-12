import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { OrdersRepository } from './orders.repository.js';
import { PaperExecutor } from './paper-executor.js';
import { QueueResolver } from './queue-resolver.js';
import { ReceiptsModule } from '@cclaw/receipts';

/**
 * Orders module — wires controller, service, repository, and execution deps.
 *
 * P1c-ii changes:
 *   - Removed static BullModule.registerQueue('execute-order') — queues are now
 *     registered dynamically by the app modules (apps/api, apps/worker) using
 *     `resolveActiveQueueNames()` and the per-Safe naming convention (ADR-0024).
 *   - Added QueueResolver provider. The resolver requires a `CHAIN_QUEUE_MAP`
 *     injection token (provided by app modules) to resolve chain → queue name.
 *   - OrdersService now uses QueueResolver instead of @InjectQueue.
 *
 * PrismaModule is global, so PrismaService is injected automatically.
 * BullMQ connection (BullModule.forRoot) is set up by the importing app module.
 */
@Module({
  imports: [
    // BullModule.registerQueue calls are intentionally absent here:
    // app modules register the per-Safe queues using resolveActiveQueueNames().
    // See apps/api/src/app.module.ts and apps/worker/src/app.module.ts.
    ReceiptsModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersRepository, PaperExecutor, QueueResolver],
  exports: [OrdersService, OrdersRepository, QueueResolver],
})
export class OrdersModule {}
