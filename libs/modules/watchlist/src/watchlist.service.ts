import { Injectable } from '@nestjs/common';
import { WatchlistRepository } from './watchlist.repository.js';
import type { AddWatchlistDto } from './dto/add-watchlist.dto.js';
import type { UpdateWatchlistDto } from './dto/update-watchlist.dto.js';
import type { WatchlistQueryDto } from './dto/watchlist-query.dto.js';
import type { WatchlistResponseDto } from './dto/watchlist-response.dto.js';

/**
 * Watchlist service — thin delegation layer between the controller and the repository.
 */
@Injectable()
export class WatchlistService {
  constructor(private readonly repo: WatchlistRepository) {}

  list(query: WatchlistQueryDto): Promise<WatchlistResponseDto[]> {
    return this.repo.findMany(query);
  }

  getById(id: string): Promise<WatchlistResponseDto> {
    return this.repo.findById(id);
  }

  add(dto: AddWatchlistDto): Promise<WatchlistResponseDto> {
    return this.repo.create(dto);
  }

  update(id: string, dto: UpdateWatchlistDto): Promise<WatchlistResponseDto> {
    return this.repo.update(id, dto);
  }

  softDelete(id: string): Promise<{ ok: boolean; id: string }> {
    return this.repo.softDelete(id);
  }
}
