import { IsString, IsNotEmpty, IsOptional, IsNumber, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** DTO for creating a sentinel alert (POST /v1/alerts). */
export class CreateAlertDto {
  @ApiProperty({ description: 'Token symbol' })
  @IsString()
  @IsNotEmpty()
  symbol!: string;

  @ApiProperty({ description: 'Chain identifier' })
  @IsString()
  @IsNotEmpty()
  chain!: string;

  @ApiProperty({
    description:
      'Alert type (stop_loss|take_profit|rug_warning|liquidity_drop|smart_money_exit|price_drop|price_spike|other)',
  })
  @IsString()
  @IsNotEmpty()
  alert_type!: string;

  @ApiProperty({ description: 'Severity level', enum: ['low', 'medium', 'high', 'critical'] })
  @IsString()
  @IsIn(['low', 'medium', 'high', 'critical'])
  severity!: string;

  @ApiPropertyOptional({ description: 'Current price at alert time' })
  @IsOptional()
  @IsNumber()
  current_price?: number;

  @ApiPropertyOptional({ description: 'Price that triggered the alert' })
  @IsOptional()
  @IsNumber()
  trigger_price?: number;

  @ApiPropertyOptional({ description: 'Detailed alert information' })
  @IsOptional()
  @IsString()
  details?: string;

  @ApiPropertyOptional({ description: 'Recommended action' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ description: 'Suggested sell amount' })
  @IsOptional()
  @IsString()
  sell_amount?: string;
}
