import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape for a single research_log row (mirrors db-query.js SELECT * output). */
export class ResearchLogResponseDto {
  @ApiProperty()
  id!: number;

  @ApiProperty()
  check_type!: string;

  @ApiProperty()
  tokens_scanned!: number;

  @ApiProperty()
  tokens_analyzed!: number;

  @ApiProperty()
  trades_proposed!: number;

  @ApiProperty()
  alerts_processed!: number;

  @ApiProperty()
  watchlist_hits!: number;

  @ApiPropertyOptional()
  summary!: string | null;

  @ApiProperty()
  status!: string;

  @ApiPropertyOptional()
  created_at!: string | null;
}
