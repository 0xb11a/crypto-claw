import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Body for POST /v1/orders/:id/approve */
export class ApproveOrderDto {
  @ApiPropertyOptional({ description: 'Identity approving the order', example: 'human' })
  @IsOptional()
  @IsString()
  by?: string;

  @ApiPropertyOptional({ description: 'Optional approval note' })
  @IsOptional()
  @IsString()
  note?: string;
}

/** Body for POST /v1/orders/:id/reject */
export class RejectOrderDto {
  @ApiPropertyOptional({ description: 'Reason for rejection' })
  @IsOptional()
  @IsString()
  reason?: string;
}

/** Body for POST /v1/orders/:id/cancel */
export class CancelOrderDto {
  @ApiPropertyOptional({ description: 'Reason for cancellation' })
  @IsOptional()
  @IsString()
  reason?: string;
}

/** Body for POST /v1/orders/:id/retry */
export class RetryOrderDto {
  @ApiPropertyOptional({ description: 'Identity initiating the retry' })
  @IsOptional()
  @IsString()
  by?: string;
}
