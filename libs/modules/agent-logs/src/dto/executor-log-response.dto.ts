import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape for a single executor_log row (mirrors db-query.js SELECT * output). */
export class ExecutorLogResponseDto {
  @ApiProperty()
  id!: number;

  @ApiProperty()
  sell_orders_processed!: number;

  @ApiProperty()
  buy_orders_processed!: number;

  @ApiProperty()
  pending_checked!: number;

  @ApiProperty()
  success_count!: number;

  @ApiProperty()
  fail_count!: number;

  @ApiProperty()
  queued_count!: number;

  @ApiProperty()
  status!: string;

  @ApiPropertyOptional()
  summary!: string | null;

  @ApiPropertyOptional()
  created_at!: string | null;
}
