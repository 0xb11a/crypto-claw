import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body DTO for POST /v1/contracts/snapshots.
 *
 * safety_data is stored and returned as raw JSON string (bug-for-bug parity
 * with db-query.js add-contract-snapshot). Max 65KB matches GoPlus blob max.
 */
export class AddContractSnapshotDto {
  @ApiProperty({ description: 'Contract address' })
  @IsString()
  @IsNotEmpty()
  address!: string;

  @ApiProperty({ description: 'Chain identifier' })
  @IsString()
  @IsNotEmpty()
  chain!: string;

  @ApiProperty({ description: 'Raw JSON string of safety check data (max 65KB)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(65536)
  json!: string;
}
