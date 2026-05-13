import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Query parameters for GET /v1/heartbeat. */
export class HeartbeatListQueryDto {
  @ApiPropertyOptional({ description: 'Filter by agent name (research|sentinel|executor|observer|system)' })
  @IsOptional()
  @IsString()
  agent?: string;
}
