import { IsOptional, IsInt, IsIn, IsISO8601 } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MinMaxValue } from '../decorators/numeric-constraints.js';

/**
 * Shared query DTO for GET /v1/logs/<agent> — applies to all four log tables.
 */
export class AgentLogQueryDto {
  @ApiPropertyOptional({ description: 'Maximum number of rows to return', default: 50 })
  @MinMaxValue(1, 500)
  @IsInt()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value != null ? Number(value) : value))
  limit?: number;

  @ApiPropertyOptional({
    description: 'ISO-8601 datetime — return rows created at or after this time',
    example: '2026-05-14T00:00:00Z',
  })
  @IsISO8601({ strict: true })
  @IsOptional()
  since?: string;

  @ApiPropertyOptional({ description: 'Filter by status (ok | warn | error)' })
  @IsIn(['ok', 'warn', 'error'])
  @IsOptional()
  status?: string;
}
