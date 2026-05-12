import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { OrdersRepository } from './orders.repository.js';
import { PaperExecutor } from './paper-executor.js';
import { ReceiptsModule } from '@cclaw/receipts';

/**
 * Orders module — wires controller, service, repository, and execution deps.
 *
 * P1c-i additions:
 *   - BullModule.registerQueue('execute-order') so OrdersService can inject Queue
 *   - ReceiptsModule for paper-mode receipt creation
 *   - PaperExecutor for paper-mode simulation
 *
 * PrismaModule is global, so PrismaService is injected automatically.
 */
@Module({
  imports: [
    // Register the execute-order queue so OrdersService can inject it via @InjectQueue
    BullModule.registerQueue({ name: 'execute-order' }),
    ReceiptsModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersRepository, PaperExecutor],
  exports: [OrdersService, OrdersRepository],
})
export class OrdersModule {}
