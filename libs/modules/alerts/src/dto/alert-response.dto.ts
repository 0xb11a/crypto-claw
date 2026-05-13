import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape for a single sentinel alert. */
export class AlertResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() symbol!: string;
  @ApiProperty() chain!: string;
  @ApiProperty() alert_type!: string;
  @ApiProperty() severity!: string;
  @ApiPropertyOptional() current_price?: number | null;
  @ApiPropertyOptional() trigger_price?: number | null;
  @ApiPropertyOptional() details?: string | null;
  @ApiPropertyOptional() action?: string | null;
  @ApiPropertyOptional() sell_amount?: string | null;
  /** 0 = unprocessed, 1 = processed/acknowledged. */
  @ApiProperty() processed!: number;
  @ApiPropertyOptional() processed_at?: string | null;
  @ApiPropertyOptional() created_at?: string | null;
}

/** Paginated list response. */
export class AlertListResponseDto {
  @ApiProperty({ type: [AlertResponseDto] }) data!: AlertResponseDto[];
  @ApiProperty()
  pagination!: {
    total: number;
    limit: number;
    cursor?: string;
    hasMore: boolean;
  };
}
