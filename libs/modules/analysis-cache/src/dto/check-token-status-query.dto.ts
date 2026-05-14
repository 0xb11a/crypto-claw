import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Query DTO for GET /v1/analysis-cache/check?address=&chain= */
export class CheckTokenStatusQueryDto {
  @ApiProperty({ description: 'Token contract address' })
  @IsString()
  @IsNotEmpty()
  address!: string;

  @ApiProperty({ description: 'Chain identifier' })
  @IsString()
  @IsNotEmpty()
  chain!: string;
}
