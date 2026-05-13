import { IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Body DTO for POST /v1/wallets/propose — mirrors propose-wallet in db-query.js. */
export class ProposeWalletDto {
  @ApiProperty({ description: 'Wallet address' })
  @IsString()
  address!: string;

  @ApiProperty({ description: 'Chain identifier (e.g. base, solana, eth)' })
  @IsString()
  chain!: string;

  @ApiPropertyOptional({ description: 'Human-readable label' })
  @IsString()
  @IsOptional()
  label?: string;

  @ApiPropertyOptional({ description: 'Token address that led to this wallet being proposed' })
  @IsString()
  @IsOptional()
  source_token?: string;

  @ApiPropertyOptional({ description: 'Source of proposal (default: agent)', default: 'agent' })
  @IsString()
  @IsOptional()
  source?: string;
}
