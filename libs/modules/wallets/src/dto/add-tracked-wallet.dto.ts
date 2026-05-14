import { IsString, IsOptional, IsNumber, IsInt } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MaxJsonBytes } from '../validators/max-json-bytes.validator.js';

/**
 * Body DTO for POST /v1/wallets — mirrors add-tracked-wallet (INSERT OR REPLACE) in db-query.js.
 *
 * If `type` is provided, the wallet is treated as already scored (status defaults to 'scored').
 * If `type` is absent, status defaults to 'proposed'.
 */
export class AddTrackedWalletDto {
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

  /** smart_money | dev | whale | deployer | trader | retail */
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  type?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ description: 'Override status (default derived from type)' })
  @IsString()
  @IsOptional()
  status?: string;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  score?: number;

  /**
   * Score breakdown — passed as an object or string; stored as raw JSON string.
   * Accepts any JSON-serialisable value. Capped at 16 384 bytes serialised.
   */
  @ApiPropertyOptional({ description: 'JSON-serialisable score breakdown; max 16 384 bytes' })
  @MaxJsonBytes(16_384)
  @IsOptional()
  score_breakdown?: unknown;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  source_token?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  source?: string;

  @ApiPropertyOptional()
  @IsInt()
  @IsOptional()
  retry_count?: number;
}
