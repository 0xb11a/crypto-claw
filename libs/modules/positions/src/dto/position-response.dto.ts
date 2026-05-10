import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shape for a single position.
 *
 * JSON-string columns (take_profit_levels, tp_levels_hit) are parsed
 * by the repository layer and returned as typed arrays here.
 */
export class PositionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() symbol!: string;
  @ApiPropertyOptional() name?: string | null;
  @ApiProperty() address!: string;
  @ApiProperty() chain!: string;
  @ApiProperty() tier!: string;
  @ApiProperty() entry_price!: number;
  @ApiPropertyOptional() current_price?: number | null;
  @ApiProperty() quantity!: number;
  @ApiPropertyOptional() value_usd?: number | null;
  @ApiPropertyOptional() percent_of_portfolio?: number | null;
  @ApiProperty() entry_date!: string;
  @ApiProperty() stop_loss!: number;
  /**
   * Parsed take-profit levels array.
   * Legacy db-query.js parses this field (JSON.parse); we match that behavior.
   */
  @ApiProperty({ type: [Number] }) take_profit_levels!: number[];
  @ApiPropertyOptional() narrative?: string | null;
  @ApiProperty() status!: string;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() onchain_balance?: number | null;
  @ApiPropertyOptional() last_synced_at?: string | null;
  @ApiPropertyOptional() exit_price?: number | null;
  @ApiPropertyOptional() exit_date?: string | null;
  @ApiPropertyOptional() pnl_percent?: number | null;
  @ApiPropertyOptional() pnl_usd?: number | null;
  @ApiPropertyOptional() exit_reason?: string | null;
  @ApiPropertyOptional() max_price_since_entry?: number | null;
  @ApiPropertyOptional() trailing_stop_pct?: number | null;
  @ApiProperty() trailing_stop_active!: number;
  /**
   * Raw JSON string of TP levels hit.
   * Legacy db-query.js does NOT parse tp_levels_hit — it returns the raw TEXT column value
   * (e.g. '[]' or '[1,2,3]'). Agent code that consumes this field calls JSON.parse() on it.
   * We match legacy here: the field is always a JSON-encoded string, never a parsed array.
   * (Asymmetry: take_profit_levels IS parsed; tp_levels_hit is NOT — both mirror db-query.js.)
   */
  @ApiProperty() tp_levels_hit!: string;
  @ApiPropertyOptional() created_at?: string | null;
  @ApiPropertyOptional() updated_at?: string | null;
  /** Whether this is a paper position. */
  @ApiProperty() mode!: 'real' | 'paper';
}

/** Paginated list response. */
export class PositionListResponseDto {
  @ApiProperty({ type: [PositionResponseDto] }) data!: PositionResponseDto[];
  @ApiProperty() pagination!: {
    total: number;
    limit: number;
    cursor?: string;
    hasMore: boolean;
  };
}
