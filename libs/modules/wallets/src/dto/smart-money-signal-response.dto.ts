import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape for a single smart-money signal row (ungrouped). */
export class SmartMoneySignalResponseDto {
  @ApiProperty() id!: number;
  @ApiProperty() tx_hash!: string;
  @ApiProperty() chain!: string;
  @ApiProperty() wallet_address!: string;
  @ApiPropertyOptional() wallet_score?: number | null;
  @ApiPropertyOptional() wallet_label?: string | null;
  /** buy | sell */
  @ApiProperty() action!: string;
  @ApiProperty() token_address!: string;
  @ApiPropertyOptional() token_symbol?: string | null;
  @ApiPropertyOptional() counter_token_address?: string | null;
  @ApiPropertyOptional() counter_token_symbol?: string | null;
  @ApiPropertyOptional() amount_token?: string | null;
  @ApiProperty() tx_timestamp!: string;
  @ApiPropertyOptional() created_at?: string | null;
}

/** Response shape for grouped (by token) smart-money signals. */
export class SmartMoneySignalGroupedResponseDto {
  @ApiProperty() token_address!: string;
  @ApiProperty() chain!: string;
  @ApiPropertyOptional() token_symbol?: string | null;
  @ApiProperty() signal_count!: number;
  @ApiProperty() n_wallets!: number;
  @ApiPropertyOptional() avg_score?: number | null;
  @ApiProperty() buys!: number;
  @ApiProperty() sells!: number;
  @ApiPropertyOptional() first_seen?: string | null;
  @ApiPropertyOptional() last_seen?: string | null;
}
