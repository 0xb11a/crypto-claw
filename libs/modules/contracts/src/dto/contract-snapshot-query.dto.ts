import { IsString, IsNotEmpty, IsOptional, IsInt, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

/** Query DTO for GET /v1/contracts/snapshots?address=&chain=&limit= */
export class ContractSnapshotQueryDto {
  @ApiProperty({ description: 'Contract address' })
  @IsString()
  @IsNotEmpty()
  address!: string;

  @ApiProperty({ description: 'Chain identifier' })
  @IsString()
  @IsNotEmpty()
  chain!: string;

  @ApiPropertyOptional({ description: 'Maximum number of rows to return (default: 5)', default: 5 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value != null ? Number(value) : value))
  limit?: number;
}
