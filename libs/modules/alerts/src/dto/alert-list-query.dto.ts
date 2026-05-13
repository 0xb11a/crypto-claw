import { IsOptional, IsBoolean, IsInt, Min, IsString } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Query parameters for GET /v1/alerts (SPEC §5). */
export class AlertListQueryDto {
  @ApiPropertyOptional({ description: 'Return only unprocessed alerts', type: Boolean })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value === 'true' || value === '1')
  @IsBoolean()
  unprocessed?: boolean;

  @ApiPropertyOptional({ description: 'Filter by alert type' })
  @IsOptional()
  @IsString()
  alertType?: string;

  @ApiPropertyOptional({ description: 'Filter by chain' })
  @IsOptional()
  @IsString()
  chain?: string;

  @ApiPropertyOptional({ description: 'Maximum results (default 50, max 200)', minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ description: 'Cursor for pagination (last alert id)' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
