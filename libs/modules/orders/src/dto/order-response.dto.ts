import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shape for a single order.
 *
 * take_profit_levels is a parsed array (not a JSON string).
 */
export class OrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() action!: string;
  @ApiProperty() symbol!: string;
  @ApiPropertyOptional() name?: string | null;
  @ApiProperty() address!: string;
  @ApiProperty() chain!: string;
  @ApiProperty() amount!: string;
  @ApiPropertyOptional() percent_of_portfolio?: number | null;
  @ApiPropertyOptional() tier?: string | null;
  @ApiPropertyOptional() entry_price?: number | null;
  @ApiPropertyOptional() stop_loss?: number | null;
  /** Parsed take-profit levels array (null if none). */
  @ApiPropertyOptional({ type: [Number] }) take_profit_levels?: number[] | null;
  @ApiPropertyOptional() analysis_score?: number | null;
  @ApiPropertyOptional() risk_score?: number | null;
  @ApiPropertyOptional() reasoning?: string | null;
  @ApiPropertyOptional() reason?: string | null;
  @ApiPropertyOptional() urgency?: string | null;
  @ApiPropertyOptional() approved_at?: string | null;
  @ApiPropertyOptional() approved_by?: string | null;
  @ApiProperty() status!: string;
  @ApiPropertyOptional() status_reason?: string | null;
  @ApiPropertyOptional() status_changed_at?: string | null;
  @ApiPropertyOptional() status_changed_by?: string | null;
  @ApiPropertyOptional() updated_at?: string | null;
  @ApiPropertyOptional() tg_message_id?: number | null;
  @ApiPropertyOptional() created_at?: string | null;
}

/** Paginated list response. */
export class OrderListResponseDto {
  @ApiProperty({ type: [OrderResponseDto] }) data!: OrderResponseDto[];
  @ApiProperty() pagination!: {
    total: number;
    limit: number;
    cursor?: string;
    hasMore: boolean;
  };
}
