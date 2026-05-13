import { IsString, IsOptional, IsNumber, IsInt } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Body DTO for PATCH /v1/wallets/:address/:chain/score — mirrors update-wallet-score. */
export class UpdateWalletScoreDto {
  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  score?: number;

  /** smart_money | dev | whale | deployer | trader | retail */
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  type?: string;

  /**
   * Score breakdown — accepts any JSON-serialisable value; stored as raw JSON string.
   */
  @ApiPropertyOptional()
  @IsOptional()
  score_breakdown?: unknown;

  @ApiPropertyOptional({ description: 'proposed | scoring | scored | failed', default: 'scored' })
  @IsString()
  @IsOptional()
  status?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  score_error?: string;

  @ApiPropertyOptional()
  @IsInt()
  @IsOptional()
  retry_count?: number;
}
