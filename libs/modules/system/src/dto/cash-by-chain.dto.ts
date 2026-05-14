import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Query DTO for GET /v1/system/cash/:chain */
export class CashChainParamDto {
  @ApiProperty({ description: 'Chain identifier' })
  @IsString()
  @IsNotEmpty()
  chain!: string;
}

/**
 * Response DTO for GET /v1/system/cash/:chain.
 * Matches legacy get-cash --chain X output: { chain, cash }.
 */
export class CashByChainDto {
  chain!: string;
  cash!: number;
}
