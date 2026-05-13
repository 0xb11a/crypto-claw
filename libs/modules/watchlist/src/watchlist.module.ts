import { Module } from '@nestjs/common';
import { WatchlistController } from './watchlist.controller.js';
import { WatchlistService } from './watchlist.service.js';
import { WatchlistRepository } from './watchlist.repository.js';

/**
 * Watchlist module — wires the watchlist table.
 *
 * PrismaModule and ConfigModule are global; no explicit imports needed.
 */
@Module({
  controllers: [WatchlistController],
  providers: [WatchlistService, WatchlistRepository],
  exports: [WatchlistService],
})
export class WatchlistModule {}
