import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { OrdersRepository } from './orders.repository.js';

/**
 * Orders module — wires controller, service, and repository.
 *
 * PrismaModule is global, so PrismaService is injected automatically.
 * Import in AppModule.
 */
@Module({
  controllers: [OrdersController],
  providers: [OrdersService, OrdersRepository],
  exports: [OrdersService, OrdersRepository],
})
export class OrdersModule {}
