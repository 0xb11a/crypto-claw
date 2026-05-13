import { IsString, IsOptional, IsInt, Min, Max, IsIn, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Body DTO for POST /v1/logs/sentinel — mirrors add-sentinel-log in db-query.js. */
export class AppendSentinelLogDto {
  @ApiProperty({ description: 'Heartbeat check type (e.g. price_check, liquidity_check)', maxLength: 64 })
  @IsString()
  @MaxLength(64)
  check_type!: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @IsOptional()
  positions_checked?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @IsOptional()
  alerts_generated?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
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
