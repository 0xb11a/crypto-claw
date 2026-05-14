import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Query DTO for GET /v1/system/meta?key= */
export class MetaQueryDto {
  @ApiProperty({ description: 'portfolio_meta key to look up' })
  @IsString()
  @IsNotEmpty()
  key!: string;
}
