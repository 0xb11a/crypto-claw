import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query DTO for GET /v1/system/portfolio.
 *
 * Both params are optional. When omitted:
 *   - `chain` → return all chains (iterated via getAllChains()).
 *   - `mode` → auto-routes by PAPER_MODE env var via SystemService.
 */
export class PortfolioQueryDto {
  @ApiPropertyOptional({ description: 'Filter to a single chain (e.g. base, solana)' })
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
