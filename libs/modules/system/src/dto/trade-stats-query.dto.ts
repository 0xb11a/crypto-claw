import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query DTO for GET /v1/system/trade-stats.
 *
 * Both params are optional. When omitted:
 *   - `chain` → aggregate across all chains.
 *   - `mode` → auto-routes by PAPER_MODE env var via SystemService.
 */
export class TradeStatsQueryDto {
  @ApiPropertyOptional({ description: 'Filter stats to a single chain (e.g. base, solana)' })
  @IsString()
  @IsOptional()
  chain?: string;

  @ApiPropertyOptional({
    description: 'Portfolio mode override — defaults to PAPER_MODE config value',
    enum: ['real', 'paper'],
  })
  @IsIn(['real', 'paper'])
  @IsOptional()
  mode?: 'real' | 'paper';
}
