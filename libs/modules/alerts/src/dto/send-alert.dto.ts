import { IsString, IsNotEmpty, IsOptional, IsObject, IsIn, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TOPIC_MAP } from '@cclaw/notifications';

/**
 * DTO for POST /v1/alerts/send — fire a Telegram notification.
 *
 * Mirrors the CLI surface of the deleted `scripts/send-alert.js`:
 *   --type  AlertType literal (15 values from TOPIC_MAP; single source of truth)
 *   --agent arbitrary agent name (e.g. "executor", "sentinel", "research")
 *   --message Telegram message body (HTML-formatted by NotificationsService)
 *   --data  optional JSON metadata (not sent to Telegram; for audit/logging only)
 *
 * Bug-for-bug parity with send-alert.js — no rate limiting, no per-type
 * formatters. Fire-and-forget: 202 is returned before TG delivery completes.
 *
 * ADR-0028 — notifications via cclaw alerts send.
 */
export class SendAlertDto {
  @ApiProperty({
    description: 'Alert type — determines the Telegram topic topic routing (TG_TOPIC_*)',
    enum: Object.keys(TOPIC_MAP),
  })
  @IsString()
  @IsNotEmpty()
  @IsIn(Object.keys(TOPIC_MAP))
  type!: string;

  @ApiProperty({
    description: 'Agent name tag shown in the alert header (e.g. "executor", "sentinel")',
    minLength: 1,
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(64)
  agent!: string;

  @ApiProperty({
    description: 'Alert message body — HTML-safe text (Telegram 4 000-character cap enforced)',
    maxLength: 4000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  message!: string;

  @ApiPropertyOptional({
    description: 'Arbitrary JSON metadata stored in the audit log; not forwarded to Telegram',
  })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}
