import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** DTO for POST /v1/heartbeat/:agent/:checkType/ping — body is optional. */
export class PingHeartbeatDto {
  @ApiPropertyOptional({ description: 'Optional note for this ping' })
  @IsOptional()
  @IsString()
  note?: string;
}
