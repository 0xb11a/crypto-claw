import { IsString, IsOptional, IsInt, IsIn, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MinMaxValue } from '../decorators/numeric-constraints.js';

/** Body DTO for POST /v1/logs/research — mirrors add-research-log in db-query.js. */
export class AppendResearchLogDto {
  @ApiProperty({ description: 'Heartbeat check type (e.g. token_scan, smart_money)', maxLength: 64 })
  @IsString()
  @MaxLength(64)
  check_type!: string;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  tokens_scanned?: number;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  tokens_analyzed?: number;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  trades_proposed?: number;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  alerts_processed?: number;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  watchlist_hits?: number;

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
