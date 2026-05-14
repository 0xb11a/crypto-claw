import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Body DTO for PATCH /v1/system/meta — set a portfolio_meta key/value. */
export class SetMetaDto {
  @ApiProperty({ description: 'portfolio_meta key' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({ description: 'Value to store (always stored as string)' })
  @IsString()
  @IsNotEmpty()
  value!: string;
}
