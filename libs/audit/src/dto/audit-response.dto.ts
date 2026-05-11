import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape for a single audit entry. */
export class ServiceAuditEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() ts!: string;
  @ApiProperty() identity!: string;
  @ApiProperty() role!: string;
  @ApiProperty() method!: string;
  @ApiProperty() path!: string;
  @ApiProperty() body_sha256!: string;
  @ApiPropertyOptional() body_redacted?: string | null;
  @ApiProperty() status!: number;
  @ApiProperty() latency_ms!: number;
  @ApiPropertyOptional() error_kind?: string | null;
}

/** Paginated audit response. */
export class AuditListResponseDto {
  @ApiProperty({ type: [ServiceAuditEntryDto] }) data!: ServiceAuditEntryDto[];
  @ApiProperty()
  pagination!: {
    total: number;
    limit: number;
    cursor?: string;
    hasMore: boolean;
  };
}
