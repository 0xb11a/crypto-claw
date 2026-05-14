import { IsString, IsNotEmpty, IsNumber } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

/** Body DTO for PATCH /v1/system/cash — update cash balance for a chain. */
export class SetCashDto {
  @ApiProperty({ description: 'Chain identifier' })
  @IsString()
  @IsNotEmpty()
  chain!: string;

  @ApiProperty({ description: 'Cash amount in USD' })
  @IsNumber()
  @Transform(({ value }: { value: unknown }) => (value != null ? Number(value) : value))
  amount!: number;
}
