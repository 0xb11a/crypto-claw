import { IsString, IsOptional, IsNumber, IsInt } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Body DTO for POST /v1/watchlist — mirrors add-to-watchlist in db-query.js. */
export class AddWatchlistDto {
  @ApiProperty({ description: 'Unique ID for this watchlist entry' })
  @IsString()
  id!: string;

  @ApiProperty({ description: 'Token symbol' })
  @IsString()
  symbol!: string;

  @ApiProperty({ description: 'Token contract address' })
  @IsString()
  address!: string;

  @ApiProperty({ description: 'Chain identifier' })
  @IsString()
  chain!: string;

  @ApiPropertyOptional({ description: 'Target entry price in USD' })
  @IsNumber()
  @IsOptional()
  target_entry?: number;

  @ApiPropertyOptional({ description: 'Current price in USD' })
  @IsNumber()
  @IsOptional()
  current_price?: number;

  @ApiPropertyOptional({ description: 'Analysis score (0-100)' })
  @IsInt()
  @IsOptional()
  analysis_score?: number;

  @ApiPropertyOptional({ description: 'Risk score (0-100)' })
  @IsInt()
  @IsOptional()
  risk_score?: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  narrative?: string;

  @ApiPropertyOptional({ description: 'Reason for adding to watchlist' })
  @IsString()
  @IsOptional()
  reason?: string;

  @ApiPropertyOptional({ description: 'ISO8601 expiry timestamp' })
  @IsString()
  @IsOptional()
  expires_at?: string;

  @ApiPropertyOptional({
    description: 'Status (default: watching)',
    enum: ['watching', 'entry_hit', 'expired', 'removed'],
  })
  @IsString()
  @IsOptional()
  status?: string;
}
