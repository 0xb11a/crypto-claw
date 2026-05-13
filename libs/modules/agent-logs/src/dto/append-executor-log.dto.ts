import { IsString, IsOptional, IsInt, Min, Max, IsIn, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Body DTO for POST /v1/logs/executor — mirrors add-executor-log in db-query.js. */
export class AppendExecutorLogDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @IsOptional()
  sell_orders_processed?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @IsOptional()
  buy_orders_processed?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @IsOptional()
  pending_checked?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @IsOptional()
  success_count?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @IsOptional()
  fail_count?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
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
