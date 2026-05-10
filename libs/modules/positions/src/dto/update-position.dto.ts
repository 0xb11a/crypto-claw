import { IsNumber, IsOptional, IsString, IsIn, IsArray, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { POSITION_STATUSES } from './position-list-query.dto.js';
import type { PositionStatus } from './position-list-query.dto.js';

/** Request body for PATCH /v1/positions/:id. All fields optional. */
export class UpdatePositionDto {
  @ApiPropertyOptional({ description: 'Updated current price' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  current_price?: number;

  @ApiPropertyOptional({ description: 'Updated quantity' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @ApiPropertyOptional({ description: 'Updated value in USD' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  value_usd?: number;

  @ApiPropertyOptional({ description: 'Updated stop-loss price' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  stop_loss?: number;

  @ApiPropertyOptional({
    description: 'Updated take-profit levels (array of numbers)',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  take_profit_levels?: number[];

  @ApiPropertyOptional({ enum: POSITION_STATUSES })
  @IsOptional()
  @IsIn(POSITION_STATUSES)
  status?: PositionStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  narrative?: string;

  @ApiPropertyOptional({ description: 'Trailing stop percentage (0–100)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  trailing_stop_pct?: number;

  @ApiPropertyOptional({ description: 'Max price observed since entry (for trailing stop)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  max_price_since_entry?: number;

  @ApiPropertyOptional({
    description: 'TP levels already hit (JSON array of booleans/indices)',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  tp_levels_hit?: number[];

  @ApiPropertyOptional({ description: 'On-chain balance (synced from chain)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  onchain_balance?: number;

  @ApiPropertyOptional({ description: 'Timestamp of last on-chain sync' })
  @IsOptional()
  @IsString()
  last_synced_at?: string;
}
