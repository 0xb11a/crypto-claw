import { Module } from '@nestjs/common';
import { PositionsController } from './positions.controller.js';
import { PositionsService } from './positions.service.js';
import { PositionsRepository } from './positions.repository.js';

/**
 * Positions module — wires controller, service, and repository.
 *
 * PrismaModule is global, so PrismaService is injected automatically.
 * Import in AppModule.
 */
@Module({
  controllers: [PositionsController],
  providers: [PositionsService, PositionsRepository],
  exports: [PositionsService, PositionsRepository],
})
export class PositionsModule {}
