import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body DTO for POST /v1/system/sync-portfolio.
 *
 * Mirrors the legacy db-query.js `sync-portfolio` trigger enum
 * (lines 2003-2026). The `chain` field is required — sync-portfolio
 * always targets a specific chain.
 */
export class SyncPortfolioDto {
  @ApiProperty({ description: 'Chain to reconcile (e.g. base, solana, ethereum)' })
  @IsString()
  chain!: string;

  @ApiPropertyOptional({
    description: 'Trigger reason for this sync. Defaults to "manual".',
    enum: ['periodic', 'post_trade', 'manual'],
    default: 'manual',
  })
  @IsIn(['periodic', 'post_trade', 'manual'])
  @IsOptional()
  trigger?: 'periodic' | 'post_trade' | 'manual';
}

/** Response from POST /v1/system/sync-portfolio when enqueued successfully (real mode). */
export class SyncPortfolioEnqueuedResponseDto {
  ok!: true;
  queued!: true;
  jobId!: string;
}

/** Response from POST /v1/system/sync-portfolio in paper mode (short-circuit). */
export class SyncPortfolioPaperResponseDto {
  ok!: false;
  message!: string;
}
