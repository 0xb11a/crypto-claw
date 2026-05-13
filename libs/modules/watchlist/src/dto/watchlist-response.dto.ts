import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape for a single watchlist row. */
export class WatchlistResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() symbol!: string;
  @ApiProperty() address!: string;
  @ApiProperty() chain!: string;
  @ApiPropertyOptional() target_entry?: number | null;
  @ApiPropertyOptional() current_price?: number | null;
  @ApiPropertyOptional() analysis_score?: number | null;
  @ApiPropertyOptional() risk_score?: number | null;
  @ApiPropertyOptional() narrative?: string | null;
  @ApiPropertyOptional() reason?: string | null;
  @ApiPropertyOptional() expires_at?: string | null;
  /** watching | entry_hit | expired | removed */
  @ApiProperty() status!: string;
  @ApiPropertyOptional() created_at?: string | null;
  @ApiPropertyOptional() updated_at?: string | null;
}
