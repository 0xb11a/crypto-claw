import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape for a single tracked wallet row. */
export class TrackedWalletResponseDto {
  @ApiProperty() address!: string;
  @ApiProperty() chain!: string;
  @ApiPropertyOptional() label?: string | null;
  /** smart_money | dev | whale | deployer | trader | retail | null */
  @ApiPropertyOptional() type?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() status!: string;
  @ApiPropertyOptional() score?: number | null;
  /** Raw JSON string (bug-for-bug parity with db-query.js). */
  @ApiPropertyOptional() score_breakdown?: string | null;
  @ApiPropertyOptional() source_token?: string | null;
  @ApiPropertyOptional() scored_at?: string | null;
  @ApiPropertyOptional() score_error?: string | null;
  @ApiProperty() retry_count!: number;
  @ApiPropertyOptional() source?: string | null;
  @ApiPropertyOptional() last_checked_at?: string | null;
  @ApiPropertyOptional() created_at?: string | null;
}
