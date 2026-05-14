import { IsString, IsOptional, IsInt, IsIn, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MinMaxValue } from '../decorators/numeric-constraints.js';

/** Body DTO for POST /v1/logs/sentinel — mirrors add-sentinel-log in db-query.js. */
export class AppendSentinelLogDto {
  @ApiProperty({ description: 'Heartbeat check type (e.g. price_check, liquidity_check)', maxLength: 64 })
  @IsString()
  @MaxLength(64)
  check_type!: string;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  positions_checked?: number;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  alerts_generated?: number;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  sells_executed?: number;

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
