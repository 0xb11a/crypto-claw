import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shape for a single heartbeat row (with computed fields). */
export class HeartbeatResponseDto {
  @ApiProperty() agent!: string;
  @ApiProperty() check!: string;
  @ApiPropertyOptional() last_run_at?: string | null;
  @ApiPropertyOptional() seconds_since?: number | null;
  @ApiPropertyOptional() expected_cadence_seconds?: number | null;
  /** Whether the agent being idle is expected (no pending work). */
  @ApiProperty() idle_ok!: boolean;
}

/** Overdue-checks response shape. */
export class OverdueChecksResponseDto {
  @ApiProperty() agent!: string;
  @ApiProperty({ type: [Object] }) overdue!: OverdueCheckEntryDto[];
  @ApiProperty({ type: [Object] }) not_yet_due!: OverdueCheckEntryDto[];
}

export class OverdueCheckEntryDto {
  @ApiProperty() check_type!: string;
  @ApiPropertyOptional() minutes_since?: number | null;
  @ApiProperty() cadence!: number;
}
