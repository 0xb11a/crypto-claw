import { IsString, IsOptional, IsInt, IsIn, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MinMaxValue } from '../decorators/numeric-constraints.js';

/** Body DTO for POST /v1/logs/executor — mirrors add-executor-log in db-query.js. */
export class AppendExecutorLogDto {
  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  sell_orders_processed?: number;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  buy_orders_processed?: number;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  pending_checked?: number;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  success_count?: number;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  fail_count?: number;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  queued_count?: number;

  @ApiPropertyOptional({ maxLength: 8192 })
  @IsString()
  @MaxLength(8192)
  @IsOptional()
  summary?: string;

  @ApiPropertyOptional({ enum: ['ok', 'warn', 'error'] })
  @IsIn(['ok', 'warn', 'error'])
  @IsOptional()
  status?: string;
}
