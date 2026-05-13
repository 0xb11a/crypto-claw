import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** DTO for acknowledging an alert (POST /v1/alerts/:id/acknowledge). */
export class AcknowledgeAlertDto {
  @ApiPropertyOptional({ description: 'Optional acknowledgment note' })
  @IsOptional()
  @IsString()
  note?: string;
}
