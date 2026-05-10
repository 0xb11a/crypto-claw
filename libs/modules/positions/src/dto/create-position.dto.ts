import { IsString, IsNumber, IsNotEmpty, IsIn, IsOptional, IsArray, ArrayMinSize, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const POSITION_TIERS = ['base', 'conviction', 'moonshot'] as const;
export type PositionTier = (typeof POSITION_TIERS)[number];

/**
 * Request body for POST /v1/positions.
 *
 * @note take_profit_levels is validated as an array of numbers here;
 * the repository layer serialises it to a JSON string before writing to SQLite
 * to maintain parity with the legacy db-query.js behaviour (OPEN-5).
 */
export class CreatePositionDto {
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

  @ApiProperty({ enum: POSITION_TIERS, description: 'Position tier' })
  @IsIn(POSITION_TIERS)
  tier!: PositionTier;

  @ApiProperty({ description: 'Entry price in USD', example: 2000.0 })
  @IsNumber()
  @Min(0)
  entry_price!: number;

  @ApiProperty({ description: 'Token quantity', example: 0.5 })
  @IsNumber()
  @Min(0)
  quantity!: number;

  @ApiProperty({ description: 'Stop-loss price in USD', example: 1600.0 })
  @IsNumber()
  @Min(0)
  stop_loss!: number;

  @ApiProperty({
    description: 'Take-profit price levels (JSON array of numbers)',
    type: [Number],
    example: [2500, 3000, 4000],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsNumber({}, { each: true })
  take_profit_levels!: number[];

  @ApiPropertyOptional({ description: 'Entry date (ISO date string)', example: '2026-05-10' })
  @IsOptional()
  @IsString()
  entry_date?: string;

  @ApiPropertyOptional({ description: 'Narrative tag', example: 'defi' })
  @IsOptional()
  @IsString()
  narrative?: string;

  @ApiPropertyOptional({ description: 'Notes' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: 'Portfolio mode (default: real)', enum: ['real', 'paper'] })
  @IsOptional()
  @IsIn(['real', 'paper'])
  mode?: 'real' | 'paper';
}
