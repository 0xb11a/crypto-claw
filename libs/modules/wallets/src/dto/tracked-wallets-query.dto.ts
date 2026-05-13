import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Query DTO for GET /v1/wallets — mirrors get-tracked-wallets options. */
export class TrackedWalletsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by status (proposed | scoring | scored | failed)' })
  @IsString()
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by type (smart_money | dev | whale | deployer | trader | retail)' })
  @IsString()
  @IsOptional()
  type?: string;

  @ApiPropertyOptional({ description: 'Filter by chain' })
  @IsString()
  @IsOptional()
  chain?: string;

  @ApiPropertyOptional({ description: 'Maximum number of rows to return', default: 100 })
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value != null ? Number(value) : value))
  limit?: number;
}
