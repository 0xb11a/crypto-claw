import { IsString, IsNotEmpty, IsOptional, IsNumber, IsIn, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** DTO for creating a receipt (POST /v1/receipts). */
export class CreateReceiptDto {
  @ApiProperty({ description: 'Associated order ID' })
  @IsString()
  @IsNotEmpty()
  order_id!: string;

  @ApiProperty({ description: 'Trade action', enum: ['buy', 'sell'] })
  @IsString()
  @IsIn(['buy', 'sell'])
  action!: string;

  @ApiProperty({ description: 'Token symbol' })
  @IsString()
  @IsNotEmpty()
  symbol!: string;

  @ApiProperty({ description: 'Token contract address' })
  @IsString()
  @IsNotEmpty()
  address!: string;

  @ApiProperty({ description: 'Chain identifier' })
  @IsString()
  @IsNotEmpty()
  chain!: string;

  @ApiProperty({ description: 'Receipt status' })
  @IsString()
  @IsNotEmpty()
  status!: string;

  @ApiPropertyOptional({ description: 'Amount traded in USD' })
  @IsOptional()
  @IsNumber()
  amount?: number;

  @ApiPropertyOptional({ description: 'Token quantity' })
  @IsOptional()
  @IsNumber()
  quantity?: number;

  @ApiPropertyOptional({ description: 'Expected price at order time' })
  @IsOptional()
  @IsNumber()
  expected_price?: number;

  @ApiPropertyOptional({ description: 'Actual executed price' })
  @IsOptional()
  @IsNumber()
  executed_price?: number;

  @ApiPropertyOptional({ description: 'Price slippage percentage' })
  @IsOptional()
  @IsNumber()
  slippage?: number;

  @ApiPropertyOptional({ description: 'Safe transaction hash (EVM)' })
  @IsOptional()
  @IsString()
  safe_tx_hash?: string;

  @ApiPropertyOptional({ description: 'On-chain transaction hash' })
  @IsOptional()
  @IsString()
  onchain_tx_hash?: string;

  @ApiPropertyOptional({ description: 'Safe nonce used' })
  @IsOptional()
  @IsInt()
  @Min(0)
  safe_nonce?: number;

  @ApiPropertyOptional({ description: 'Number of signatures collected' })
  @IsOptional()
  @IsInt()
  @Min(0)
  signatures_collected?: number;

  @ApiPropertyOptional({ description: 'Number of signatures required' })
  @IsOptional()
  @IsInt()
  @Min(0)
  signatures_required?: number;

  @ApiPropertyOptional({ description: 'Gas used (as string for large integers)' })
  @IsOptional()
  @IsString()
  gas_used?: string;

  @ApiPropertyOptional({ description: 'Error message if execution failed' })
  @IsOptional()
  @IsString()
  error?: string;

  @ApiPropertyOptional({ description: 'Additional notes' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: 'Associated position ID' })
  @IsOptional()
  @IsString()
  position_id?: string;

  @ApiPropertyOptional({ description: 'Portfolio mode (real|paper)', enum: ['real', 'paper'] })
  @IsOptional()
  @IsIn(['real', 'paper'])
  mode?: 'real' | 'paper';
}

/** DTO for creating a paper receipt (POST /v1/receipts with mode=paper). */
export class CreatePaperReceiptDto {
  @ApiProperty({ description: 'Associated order ID' })
  @IsString()
  @IsNotEmpty()
  order_id!: string;

  @ApiProperty({ description: 'Trade action', enum: ['buy', 'sell'] })
  @IsString()
  @IsIn(['buy', 'sell'])
  action!: string;

  @ApiProperty({ description: 'Token symbol' })
  @IsString()
  @IsNotEmpty()
  symbol!: string;

  @ApiProperty({ description: 'Token contract address' })
  @IsString()
  @IsNotEmpty()
  address!: string;

  @ApiProperty({ description: 'Chain identifier' })
  @IsString()
  @IsNotEmpty()
  chain!: string;

  @ApiProperty({ description: 'Proposed price at order time' })
  @IsNumber()
  proposed_price!: number;

  @ApiPropertyOptional({ description: 'Tier (moonshot|conviction|base)' })
  @IsOptional()
  @IsString()
  tier?: string;

  @ApiPropertyOptional({ description: 'Token quantity' })
  @IsOptional()
  @IsNumber()
  quantity?: number;

  @ApiPropertyOptional({ description: 'Amount traded in USD' })
  @IsOptional()
  @IsNumber()
  amount?: number;

  @ApiPropertyOptional({ description: 'Stop loss price' })
  @IsOptional()
  @IsNumber()
  stop_loss?: number;

  @ApiPropertyOptional({ description: 'Take profit levels as JSON string' })
  @IsOptional()
  @IsString()
  take_profit_levels?: string;

  @ApiPropertyOptional({ description: 'Analysis reasoning' })
  @IsOptional()
  @IsString()
  reasoning?: string;

  @ApiPropertyOptional({ description: 'P&L percentage' })
  @IsOptional()
  @IsNumber()
  pnl_percent?: number;

  @ApiPropertyOptional({ description: 'P&L in USD' })
  @IsOptional()
  @IsNumber()
  pnl_usd?: number;
}
