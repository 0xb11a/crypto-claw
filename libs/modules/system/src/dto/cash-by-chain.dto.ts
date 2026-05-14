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
 * Matches legacy get-cash --chain X output: { chain, cash, _mode }.
 *
 * _mode mirrors the legacy db-query.js output() function which appends
 * `_mode: 'paper' | 'real'` to every non-array response object. Required for
 * byte-identical parity with the legacy CLI (ADR-0020).
 */
export class CashByChainDto {
  chain!: string;
  cash!: number;
  _mode!: 'real' | 'paper';
}
