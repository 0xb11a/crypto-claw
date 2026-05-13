import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape for a single sentinel_log row (mirrors db-query.js SELECT * output). */
export class SentinelLogResponseDto {
  @ApiProperty()
  id!: number;

  @ApiProperty()
  check_type!: string;

  @ApiProperty()
  positions_checked!: number;

  @ApiProperty()
  alerts_generated!: number;

  @ApiProperty()
  sells_executed!: number;

  @ApiProperty()
  status!: string;

  @ApiPropertyOptional()
  summary!: string | null;

  @ApiPropertyOptional()
  created_at!: string | null;
}
