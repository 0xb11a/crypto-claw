import { IsString, IsNotEmpty, IsOptional, IsInt, Min, Max, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

/**
 * Body DTO for POST /v1/analysis-cache — upserts a cache entry for a token.
 *
 * TTL parity decision (ADR-0020):
 *   expires_at is stored as SQLite TEXT "YYYY-MM-DD HH:MM:SS" (non-Z) via
 *   `datetime('now', '+N hours')` called inside a $queryRawUnsafe. This matches
 *   the legacy db-query.js cache-analysis command exactly.
 *   The ttl_hours field (default 24) maps 1:1 to the legacy `ttl_hours` JSON field.
 */
export class CacheAnalysisDto {
  @ApiProperty({ description: 'Token contract address' })
  @IsString()
  @IsNotEmpty()
  address!: string;

  @ApiProperty({ description: 'Chain identifier (base, solana, etc.)' })
  @IsString()
  @IsNotEmpty()
  chain!: string;

  @ApiPropertyOptional({ description: 'Token symbol' })
  @IsString()
  @IsOptional()
  symbol?: string;

  @ApiPropertyOptional({ description: 'Analysis score (0-100)' })
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value != null ? Number(value) : value))
  analysis_score?: number;

  @ApiPropertyOptional({ description: 'Risk score (0-100)' })
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value != null ? Number(value) : value))
  risk_score?: number;

  @ApiProperty({ description: 'Verdict: buy | hold | avoid | skip | analyze' })
  @IsString()
  @IsNotEmpty()
  verdict!: string;

  @ApiPropertyOptional({ description: 'Tier: base | conviction | moonshot' })
  @IsString()
  @IsOptional()
  tier?: string;

  @ApiPropertyOptional({ description: 'Analysis reasoning text' })
  @IsString()
  @IsOptional()
  reasoning?: string;

  @ApiPropertyOptional({ description: 'Cache TTL in hours (default: 24)', default: 24 })
  @IsNumber()
  @Min(1)
  @Max(720)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value != null ? Number(value) : value))
  ttl_hours?: number;
}
