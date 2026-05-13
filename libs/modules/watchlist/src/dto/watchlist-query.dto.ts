import { IsString, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query DTO for GET /v1/watchlist.
 *
 * Legacy semantics (db-query.js get-watchlist):
 *   --active  → only 'watching' rows
 *   (default) → all rows
 *
 * New API supports ?status to filter explicitly; 'all' or omitted returns all rows.
 */
export class WatchlistQueryDto {
  @ApiPropertyOptional({
    description: "Filter by status. Use 'watching' for active-only, 'all' or omit for all rows.",
    enum: ['watching', 'entry_hit', 'expired', 'removed', 'all'],
  })
  @IsString()
  @IsOptional()
  status?: string;
}
