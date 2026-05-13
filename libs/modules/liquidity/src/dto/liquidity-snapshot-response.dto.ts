import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape for a single liquidity snapshot row. */
export class LiquiditySnapshotResponseDto {
  @ApiProperty() id!: number;
  @ApiProperty() address!: string;
  @ApiProperty() chain!: string;
  @ApiProperty() liquidity_usd!: number;
  @ApiPropertyOptional() checked_at?: string | null;
}
