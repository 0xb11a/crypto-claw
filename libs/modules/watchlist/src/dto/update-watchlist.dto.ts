import { IsString, IsOptional, IsNumber, IsInt } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Body DTO for PATCH /v1/watchlist/:id — mirrors update-watchlist in db-query.js. */
export class UpdateWatchlistDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  symbol?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  address?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  chain?: string;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  target_entry?: number;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  current_price?: number;

  @ApiPropertyOptional()
  @IsInt()
  @IsOptional()
  analysis_score?: number;

  @ApiPropertyOptional()
  @IsInt()
  @IsOptional()
  risk_score?: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  narrative?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  reason?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  expires_at?: string;

  @ApiPropertyOptional({ enum: ['watching', 'entry_hit', 'expired', 'removed'] })
  @IsString()
  @IsOptional()
  status?: string;
}
