import { Module } from '@nestjs/common';
import { ReceiptsController } from './receipts.controller.js';
import { ReceiptsService } from './receipts.service.js';
import { ReceiptsRepository } from './receipts.repository.js';

/**
 * Receipts module — wires controller, service, and repository.
 *
 * PrismaModule is global, so PrismaService is injected automatically.
 * Import in AppModule.
 */
@Module({
  controllers: [ReceiptsController],
  providers: [ReceiptsService, ReceiptsRepository],
  exports: [ReceiptsService, ReceiptsRepository],
})
export class ReceiptsModule {}
