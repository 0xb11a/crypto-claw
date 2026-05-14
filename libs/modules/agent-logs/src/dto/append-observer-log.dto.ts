import { IsString, IsOptional, IsInt, IsIn, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MinMaxValue } from '../decorators/numeric-constraints.js';

/** Body DTO for POST /v1/logs/observer — mirrors add-observer-log in db-query.js. */
export class AppendObserverLogDto {
  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  errors_analyzed?: number;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  issues_created?: number;

  @MinMaxValue(0, 1_000_000)
  @IsInt()
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
