import { IsString, IsNotEmpty, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

/** Body DTO for PATCH /v1/system/cash — update cash balance for a chain. */
export class SetCashDto {
  @ApiProperty({ description: 'Chain identifier' })
  @IsString()
  @IsNotEmpty()
  chain!: string;

  @ApiProperty({ description: 'Cash amount in USD (must be ≥ 0)', minimum: 0 })
  @IsNumber()
  @Min(0)
  @Transform(({ value }: { value: unknown }) => (value != null ? Number(value) : value))
  amount!: number;
}
