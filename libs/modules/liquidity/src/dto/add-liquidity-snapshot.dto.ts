import { IsString, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Body DTO for POST /v1/liquidity — mirrors add-liquidity-snapshot in db-query.js. */
export class AddLiquiditySnapshotDto {
  @ApiProperty({ description: 'Token or pool contract address' })
  @IsString()
  address!: string;

  @ApiProperty({ description: 'Chain identifier (e.g. base, solana, eth)' })
  @IsString()
  chain!: string;

  @ApiProperty({ description: 'Liquidity in USD; must be >= 0' })
  @IsNumber()
  @Min(0)
  liquidity_usd!: number;
}
