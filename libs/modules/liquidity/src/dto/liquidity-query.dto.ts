import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Query DTO for GET /v1/liquidity — mirrors get-liquidity options in db-query.js. */
export class LiquidityQueryDto {
  @ApiPropertyOptional({ description: 'Filter by contract address' })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiPropertyOptional({ description: 'Filter by chain' })
  @IsString()
  @IsOptional()
  chain?: string;

  @ApiPropertyOptional({ description: 'Maximum rows to return (default: 2 per address/chain pair)', default: 2 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value != null ? Number(value) : value))
  limit?: number;
}
