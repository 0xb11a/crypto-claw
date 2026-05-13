import { IsString, IsOptional, IsInt, IsBoolean, Min, Max, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Query DTO for GET /v1/wallets/signals — mirrors get-smart-money-signals flags. */
export class SignalsQueryDto {
  /**
   * Sliding window duration (e.g. 35m, 2h, 1d).
   * Default: 35m.
   */
  @ApiPropertyOptional({ description: 'Time window (e.g. 35m, 2h, 1d)', default: '35m' })
  @IsString()
  @Matches(/^\d+[mhd]$/, { message: 'since must match pattern Nm, Nh, or Nd (e.g. 35m, 2h, 1d)' })
  @IsOptional()
  since?: string;

  /** buy | sell (omit for both) */
  @ApiPropertyOptional({ description: 'Filter by action (buy | sell)' })
  @IsString()
  @IsOptional()
  action?: string;

  @ApiPropertyOptional({ description: 'Filter by chain' })
  @IsString()
  @IsOptional()
  chain?: string;

  /**
   * Group results by token address.
   * When set to 'token', returns aggregated rows.
   */
  @ApiPropertyOptional({ description: 'Group results by token', enum: ['token'] })
  @IsString()
  @IsOptional()
  group_by?: string;

  /**
   * Minimum number of distinct wallets (only effective when group_by=token).
   */
  @ApiPropertyOptional({ description: 'Minimum wallet count (requires group_by=token)', default: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value != null ? Number(value) : value))
  min_wallets?: number;

  @ApiPropertyOptional({ description: 'Maximum rows to return', default: 100 })
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value != null ? Number(value) : value))
  limit?: number;

  /**
   * When true, restricts signals to tokens that are currently in open positions.
   * Mirrors --tokens-in-positions flag in db-query.js.
   */
  @ApiPropertyOptional({ description: 'Only return signals for tokens currently in open positions' })
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  tokens_in_positions?: boolean;
}
