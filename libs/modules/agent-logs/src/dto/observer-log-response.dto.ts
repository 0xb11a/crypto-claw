import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape for a single observer_log row (mirrors db-query.js SELECT * output). */
export class ObserverLogResponseDto {
  @ApiProperty()
  id!: number;

  @ApiProperty()
  errors_analyzed!: number;

  @ApiProperty()
  issues_created!: number;

  @ApiProperty()
  alerts_sent!: number;

  @ApiPropertyOptional()
  summary!: string | null;

  @ApiProperty()
  status!: string;

  @ApiPropertyOptional()
  created_at!: string | null;
}
