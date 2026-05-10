import { IsOptional, IsIn, IsInt, Min, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Valid position status values (mirrors legacy CHECK constraint). */
export const POSITION_STATUSES = [
  'open',
  'partial_exit',
  'closed',
  'pending_analysis',
  'draft',
  'pending_exit',
] as const;
export type PositionStatus = (typeof POSITION_STATUSES)[number];

/** Query parameters for GET /v1/positions (SPEC §5). */
export class PositionListQueryDto {
  @ApiPropertyOptional({ enum: POSITION_STATUSES, description: 'Filter by position status' })
  @IsOptional()
  @IsIn(POSITION_STATUSES)
  status?: PositionStatus;

  @ApiPropertyOptional({ enum: ['real', 'paper'], description: 'Portfolio mode (default: real)' })
  @IsOptional()
  @IsIn(['real', 'paper'])
  mode?: 'real' | 'paper';

  @ApiPropertyOptional({ description: 'Filter by token symbol (case-insensitive)' })
  @IsOptional()
  @IsString()
  symbol?: string;

  @ApiPropertyOptional({ description: 'Filter by chain', example: 'base' })
  @IsOptional()
  @IsString()
  chain?: string;

  @ApiPropertyOptional({ description: 'Maximum number of results (default 50, max 200)', minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ description: 'Cursor for pagination (last position id)' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
