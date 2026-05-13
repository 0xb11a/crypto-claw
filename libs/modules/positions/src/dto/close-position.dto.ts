import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Request body for POST /v1/positions/:id/close. */
export class ClosePositionDto {
  @ApiProperty({ description: 'Exit price in USD', example: 2500.0 })
  @IsNumber()
  @Min(0)
  exit_price!: number;

  @ApiPropertyOptional({ description: 'Exit reason', example: 'take_profit' })
  @IsOptional()
  @IsString()
  exit_reason?: string;

  @ApiPropertyOptional({ description: 'Final P&L percent' })
  @IsOptional()
  @IsNumber()
  pnl_percent?: number;

  @ApiPropertyOptional({ description: 'Final P&L in USD' })
  @IsOptional()
  @IsNumber()
  pnl_usd?: number;

  @ApiPropertyOptional({ description: 'Exit date (ISO date string)', example: '2026-05-10' })
  @IsOptional()
  @IsString()
  exit_date?: string;
}
