/**
 * NotificationsService — typed wrappers for CryptoClaw alert delivery.
 *
 * Wraps TelegramAdapter with topic routing (TOPIC_MAP) and message formatting
 * (emoji prefix + SAFE_ID footer) — porting the logic from `scripts/send-alert.js`.
 *
 * Each method corresponds to one `TYPE` literal from the legacy script.
 * This is a thin orchestration layer; no business logic lives here.
 *
 * Config reads (ADR-0026 — per-field):
 *   - `TELEGRAM_CHAT_ID`   — Target supergroup/chat ID.
 *   - `SAFE_ID`            — Fund identifier (appended to every message).
 *   - `TG_TOPIC_*`         — Per-topic thread IDs.
 *
 * SPEC §4 #6 — no `process.env` reads.
 * SPEC §4 #4 — no signer-key env vars read here.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TelegramAdapter,
  TOPIC_MAP,
  EMOJI_MAP,
  TelegramBotTokenMissingError,
  type AlertType,
} from './telegram.adapter.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CriticalAlertPayload {
  type: AlertType;
  agent: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Separator line ported from scripts/send-alert.js. */
const SEP = '────────────────';

/**
 * NestJS injectable service for Telegram alert delivery.
 *
 * Topic routing uses the TOPIC_MAP constant, which maps each alert type to
 * a TG_TOPIC_* env-var key (ADR-0026: config.get<string> per field).
 * If the resolved topic env-var is absent or TELEGRAM_BOT_TOKEN is missing,
 * the alert is silently dropped — alerting must never block the main pipeline.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly telegram: TelegramAdapter,
    private readonly configService: ConfigService,
  ) {}

  /** Resolve TELEGRAM_CHAT_ID — returns undefined if not configured. ADR-0026. */
  private getChatId(): string | undefined {
    return this.configService.get<string>('TELEGRAM_CHAT_ID');
  }

  /** Resolve SAFE_ID for footer — ADR-0026. */
  private getSafeId(): string {
    return this.configService.get<string>('SAFE_ID') ?? 'unknown';
  }

  /**
   * Resolve the thread ID for a given alert type.
   *
   * Reads the env-var key from TOPIC_MAP, then resolves the actual thread ID
   * via configService.get. Returns undefined if the topic is not configured.
   *
   * ADR-0026: uses a runtime-keyed `configService.get<string>(topicEnvVar)`.
   * The key is one of a known static set (TG_TOPIC_*) — this is a deliberate
   * ADR-0026 exception, not an aggregate config fetch.
   */
  private getThreadId(type: AlertType): string | undefined {
    const topicEnvVar = TOPIC_MAP[type];
    if (!topicEnvVar) return undefined;
    // ADR-0026 exception: runtime-keyed get for static TG_TOPIC_* fields.
    return this.configService.get<string>(topicEnvVar);
  }

  /**
   * Format a message with emoji prefix and SAFE_ID footer.
   *
   * Mirrors the format from `scripts/send-alert.js` — bug-for-bug parity.
   */
  private formatMessage(type: AlertType, agent: string, message: string): string {
    const emoji = EMOJI_MAP[type] ?? '🔔';
    const safeId = this.getSafeId();
    return `${emoji} <b>[${agent.toUpperCase()}]</b> ${message}\n${SEP}\n<i>Fund: ${safeId}</i>`;
  }

  /**
   * Send a critical alert to the appropriate Telegram topic.
   *
   * Silently drops the alert (logs a warning) if:
   *   - TELEGRAM_CHAT_ID is not set
   *   - TELEGRAM_BOT_TOKEN is not set
   *   - The topic thread ID for this alert type is not set
   *
   * This matches the legacy `send-alert.js` fail-safe pattern: alerting
   * must never block the main pipeline.
   */
  async sendCriticalAlert(payload: CriticalAlertPayload): Promise<void> {
    const { type, agent, message } = payload;
    const chatId = this.getChatId();
    if (!chatId) {
      this.logger.debug(`notifications: TELEGRAM_CHAT_ID not set — skipping alert type=${type}`);
      return;
    }

    const threadId = this.getThreadId(type);
    const text = this.formatMessage(type, agent, message);

    try {
      await this.telegram.sendMessage({ chatId, text, threadId, parseMode: 'HTML' });
      this.logger.log(`notifications: alert sent type=${type} agent=${agent}`);
    } catch (err) {
      if (err instanceof TelegramBotTokenMissingError) {
        this.logger.debug(`notifications: TELEGRAM_BOT_TOKEN not set — skipping alert type=${type}`);
        return;
      }
      // Log and swallow — alerting must not crash processors.
      this.logger.warn(`notifications: failed to send alert type=${type} — ${(err as Error).message}`);
    }
  }

  /** Send a trade-executed alert (executor → TG_TOPIC_EXECUTOR). */
  async sendTradeExecuted(agent: string, message: string): Promise<void> {
    return this.sendCriticalAlert({ type: 'trade_executed', agent, message });
  }

  /** Send a trade-failed alert (executor → TG_TOPIC_EXECUTOR). */
  async sendTradeFailed(agent: string, message: string): Promise<void> {
    return this.sendCriticalAlert({ type: 'trade_failed', agent, message });
  }

  /** Send a rug-warning alert (observer → TG_TOPIC_ALERTS). */
  async sendRugWarning(agent: string, message: string): Promise<void> {
    return this.sendCriticalAlert({ type: 'rug_warning', agent, message });
  }

  /** Send a system-health alert (observer → TG_TOPIC_OBSERVER). */
  async sendSystemHealth(agent: string, message: string): Promise<void> {
    return this.sendCriticalAlert({ type: 'system_health', agent, message });
  }

  /** Send a portfolio-daily report (system → TG_TOPIC_PORTFOLIO). */
  async sendPortfolioDaily(agent: string, message: string): Promise<void> {
    return this.sendCriticalAlert({ type: 'portfolio_daily', agent, message });
  }
}
