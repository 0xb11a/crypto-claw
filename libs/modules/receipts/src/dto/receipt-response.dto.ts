import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape for a single receipt (real or paper). */
export class ReceiptResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() order_id!: string;
  @ApiProperty() action!: string;
  @ApiProperty() symbol!: string;
  @ApiProperty() address!: string;
  @ApiProperty() chain!: string;
  @ApiProperty() status!: string;
  @ApiPropertyOptional() amount?: number | null;
  @ApiPropertyOptional() quantity?: number | null;
  @ApiPropertyOptional() expected_price?: number | null;
  @ApiPropertyOptional() executed_price?: number | null;
  @ApiPropertyOptional() slippage?: number | null;
  @ApiPropertyOptional() safe_tx_hash?: string | null;
  @ApiPropertyOptional() onchain_tx_hash?: string | null;
  @ApiPropertyOptional() safe_nonce?: number | null;
  @ApiPropertyOptional() signatures_collected?: number | null;
  @ApiPropertyOptional() signatures_required?: number | null;
  @ApiPropertyOptional() gas_used?: string | null;
  @ApiPropertyOptional() error?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() position_id?: string | null;
  /** 'real' or 'paper' — indicates which table this came from. */
  @ApiProperty({ enum: ['real', 'paper'] }) mode!: 'real' | 'paper';
  @ApiPropertyOptional() created_at?: string | null;

  // paper-receipt-only fields (undefined for real receipts)
  @ApiPropertyOptional() tier?: string | null;
  @ApiPropertyOptional() proposed_price?: number | null;
  @ApiPropertyOptional() stop_loss?: number | null;
  @ApiPropertyOptional() take_profit_levels?: string | null;
  @ApiPropertyOptional() reasoning?: string | null;
  @ApiPropertyOptional() pnl_percent?: number | null;
  @ApiPropertyOptional() pnl_usd?: number | null;
}

/** Paginated list response. */
export class ReceiptListResponseDto {
  @ApiProperty({ type: [ReceiptResponseDto] }) data!: ReceiptResponseDto[];
  @ApiProperty()
  pagination!: {
    total: number;
    limit: number;
    cursor?: string;
    hasMore: boolean;
  };
}
