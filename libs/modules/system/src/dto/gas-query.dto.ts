import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Query DTO for GET /v1/system/gas?chain= */
export class GasQueryDto {
  @ApiProperty({ description: 'Chain identifier' })
  @IsString()
  @IsNotEmpty()
  chain!: string;
}

/**
 * Response DTO for GET /v1/system/gas?chain=X.
 * Matches legacy get-gas --chain X output shape.
 */
export class GasResponseDto {
  chain!: string;
  symbol!: string | null;
  balance!: number;
  price!: number;
  value_usd!: number;
}
