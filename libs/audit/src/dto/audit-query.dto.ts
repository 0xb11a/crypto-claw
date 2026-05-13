import { IsOptional, IsString, IsIn, IsInt, Min, Max, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Valid HTTP methods for audit filtering. */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** Query parameters for GET /v1/system/audit (SPEC §9.5, ADR-0018). */
export class AuditQueryDto {
  @ApiPropertyOptional({ description: 'Filter by identity (e.g. RESEARCH, EXECUTOR)' })
  @IsOptional()
  @IsString()
  identity?: string;

  @ApiPropertyOptional({ description: 'Filter by role (agent|dashboard)', enum: ['agent', 'dashboard'] })
  @IsOptional()
  @IsIn(['agent', 'dashboard'])
  role?: string;

  @ApiPropertyOptional({ description: 'Filter by HTTP method', enum: HTTP_METHODS })
  @IsOptional()
  @IsIn(HTTP_METHODS)
  method?: HttpMethod;

  @ApiPropertyOptional({ description: 'Substring match on path' })
  @IsOptional()
  @IsString()
  pathContains?: string;

  @ApiPropertyOptional({ description: 'Filter by HTTP status code' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;

  @ApiPropertyOptional({ description: 'Return entries from this ISO timestamp onward' })
  @IsOptional()
  @IsDateString()
  since?: string;

  @ApiPropertyOptional({ description: 'Return entries up to this ISO timestamp' })
  @IsOptional()
  @IsDateString()
  until?: string;

  @ApiPropertyOptional({ description: 'Maximum results (default 100, max 1000)', minimum: 1, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @ApiPropertyOptional({ description: 'Keyset cursor (last seen id from previous page)' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
