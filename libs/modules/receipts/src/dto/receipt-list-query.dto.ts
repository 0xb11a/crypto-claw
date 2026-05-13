import { IsOptional, IsIn, IsInt, Min, IsString, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Query parameters for GET /v1/receipts (SPEC §5). */
export class ReceiptListQueryDto {
  @ApiPropertyOptional({ description: 'Filter by status' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Portfolio mode (real|paper)', enum: ['real', 'paper'] })
  @IsOptional()
  @IsIn(['real', 'paper'])
  mode?: 'real' | 'paper';

  @ApiPropertyOptional({ description: 'Filter receipts created after this ISO timestamp' })
  @IsOptional()
  @IsDateString()
  since?: string;

  @ApiPropertyOptional({ description: 'Filter receipts created before this ISO timestamp' })
  @IsOptional()
  @IsDateString()
  until?: string;

  @ApiPropertyOptional({ description: 'Filter by order ID' })
  @IsOptional()
  @IsString()
  orderId?: string;

  @ApiPropertyOptional({ description: 'Maximum results (default 50, max 200)', minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ description: 'Cursor for pagination (last receipt id)' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
