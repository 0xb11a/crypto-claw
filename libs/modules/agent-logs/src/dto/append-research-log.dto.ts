import { IsString, IsOptional, IsInt, Min, Max, IsIn, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Body DTO for POST /v1/logs/research — mirrors add-research-log in db-query.js. */
export class AppendResearchLogDto {
  @ApiProperty({ description: 'Heartbeat check type (e.g. token_scan, smart_money)', maxLength: 64 })
  @IsString()
  @MaxLength(64)
  check_type!: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @IsOptional()
  tokens_scanned?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @IsOptional()
  tokens_analyzed?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @IsOptional()
  trades_proposed?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @IsOptional()
  alerts_processed?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
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
