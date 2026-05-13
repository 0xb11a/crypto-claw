import { IsString, IsOptional, IsInt, Min, Max, IsIn, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Body DTO for POST /v1/logs/observer — mirrors add-observer-log in db-query.js. */
export class AppendObserverLogDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @IsOptional()
  errors_analyzed?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @IsOptional()
  issues_created?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @IsOptional()
  alerts_sent?: number;

  @ApiPropertyOptional({ maxLength: 8192 })
  @IsString()
  @MaxLength(8192)
  @IsOptional()
  summary?: string;

  @ApiPropertyOptional({ enum: ['ok', 'warn', 'error'] })
  @IsIn(['ok', 'warn', 'error'])
  @IsOptional()
  status?: string;
}
