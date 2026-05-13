import { IsString, IsOptional, IsInt, Min, Max, IsIn } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Shared query DTO for GET /v1/logs/<agent> — applies to all four log tables.
 */
export class AgentLogQueryDto {
  @ApiPropertyOptional({ description: 'Maximum number of rows to return', default: 50 })
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value != null ? Number(value) : value))
  limit?: number;

  @ApiPropertyOptional({ description: 'ISO-8601 datetime — return rows created at or after this time' })
  @IsString()
  @IsOptional()
  since?: string;

  @ApiPropertyOptional({ description: 'Filter by status (ok | warn | error)' })
  @IsIn(['ok', 'warn', 'error'])
  @IsOptional()
  status?: string;
}
