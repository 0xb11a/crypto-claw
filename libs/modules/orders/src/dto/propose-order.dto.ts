import { IsString, IsNumber, IsNotEmpty, IsIn, IsOptional, IsArray, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Valid order actions. */
export const ORDER_ACTIONS = ['buy', 'sell'] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];

/**
 * Request body for POST /v1/orders (propose a new order).
 *
 * This maps to the legacy "add-order" command in db-query.js.
 * amount is a string because it can be '100%', '50%', '30%', 'all', or a
 * numeric string — matches the legacy schema (amount TEXT NOT NULL).
 */
export class ProposeOrderDto {
  @ApiProperty({ enum: ORDER_ACTIONS, description: 'Order action' })
  @IsIn(ORDER_ACTIONS)
  action!: OrderAction;

  @ApiProperty({ description: 'Token symbol', example: 'ETH' })
  @IsString()
  @IsNotEmpty()
  symbol!: string;

  @ApiPropertyOptional({ description: 'Token name', example: 'Ethereum' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ description: 'Token contract address', example: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' })
  @IsString()
  @IsNotEmpty()
  address!: string;

  @ApiProperty({ description: 'Chain identifier', example: 'base' })
  @IsString()
  @IsNotEmpty()
  chain!: string;

  @ApiProperty({
    description: 'Amount to trade (percentage, "all", or USD value as string)',
    example: '100',
  })
  @IsString()
  @IsNotEmpty()
  amount!: string;

  @ApiPropertyOptional({ description: 'Percent of portfolio', example: 5.0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  percent_of_portfolio?: number;

  @ApiPropertyOptional({ description: 'Position tier', example: 'conviction' })
  @IsOptional()
  @IsString()
  tier?: string;

  @ApiPropertyOptional({ description: 'Entry price in USD' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  entry_price?: number;

  @ApiPropertyOptional({ description: 'Stop-loss price' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  stop_loss?: number;

  @ApiPropertyOptional({ description: 'Take-profit levels (array of numbers)', type: [Number] })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  take_profit_levels?: number[];

  @ApiPropertyOptional({ description: 'Analysis score (0–100)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  analysis_score?: number;

  @ApiPropertyOptional({ description: 'Risk score (0–100)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  risk_score?: number;

  @ApiPropertyOptional({ description: 'Reasoning for this order' })
  @IsOptional()
  @IsString()
  reasoning?: string;

  @ApiPropertyOptional({ description: 'Sell reason (for sell orders)' })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({ description: 'Sell urgency', example: 'immediate' })
  @IsOptional()
  @IsString()
  urgency?: string;
}
