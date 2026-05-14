import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

/** Query DTO for GET /v1/system/sync-status */
export class SyncStatusQueryDto {
  @ApiPropertyOptional({ description: 'Filter by chain' })
  @IsString()
  @IsOptional()
  chain?: string;

  @ApiPropertyOptional({ description: 'Maximum number of rows to return', default: 20 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value != null ? Number(value) : value))
  limit?: number;
}
