import { IsOptional, IsIn, IsBoolean, IsInt, Min, IsString } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Valid order statuses (migration 014 state machine). */
export const ORDER_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'executed',
  'failed',
  'expired',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Query parameters for GET /v1/orders (SPEC §5). */
export class OrderListQueryDto {
  @ApiPropertyOptional({ enum: ORDER_STATUSES, description: 'Filter by order status' })
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;

  @ApiPropertyOptional({ enum: ['buy', 'sell'], description: 'Filter by action' })
  @IsOptional()
  @IsIn(['buy', 'sell'])
  action?: 'buy' | 'sell';

  @ApiPropertyOptional({ description: 'Show only pending orders', type: Boolean })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value === 'true' || value === '1')
  @IsBoolean()
  pending?: boolean;

  @ApiPropertyOptional({ description: 'Maximum results (default 50, max 200)', minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ description: 'Cursor for pagination (last order id)' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
