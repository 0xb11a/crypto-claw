import { IsInt, IsOptional, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

/** Query DTO for GET /v1/analysis-cache — list non-expired entries. */
export class AnalysisCacheQueryDto {
  @ApiPropertyOptional({ description: 'Maximum number of rows to return', default: 50 })
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value != null ? Number(value) : value))
  limit?: number;
}
