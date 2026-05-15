/**
 * TelegramAdapter — HTTP client for the Telegram Bot API.
 *
 * Provides message sending, editing, and update polling for Telegram bots.
 * Used by NotificationsService (PR-D: sendCriticalAlert) and future
 * approval-bot (PR-F: getUpdates, answerCallbackQuery).
 *
 * Topic routing constants (TOPIC_MAP, EMOJI_MAP) are ported from
 * `scripts/send-alert.js` — bug-for-bug parity (DoD §I).
 *
 * Config reads (ADR-0026 — per-field):
 *   - `TELEGRAM_BOT_TOKEN`  — Main bot token (read lazily; optional).
 *   - `TELEGRAM_CHAT_ID`    — Target supergroup/chat ID.
 *
 * SPEC §4 #6 — no `process.env` reads; all config via ConfigService.
 * SPEC §4 #4 — no signer-key env vars read here.
 * ADR-0026    — per-field config access only.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Alert type union — mirrors send-alert.js TYPE literals (DoD §I)
// ---------------------------------------------------------------------------

export type AlertType =
  | 'recovered'
  | 'trade_proposal'
  | 'trade_executed'
  | 'trade_failed'
  | 'trade_retry'
  | 'sell_triggered'
  | 'sentinel_alert_followup'
  | 'model_failure'
  | 'emergency_mode'
  | 'rug_warning'
  | 'signer_low_balance'
  | 'system_health'
  | 'heartbeat_summary'
  | 'portfolio_daily'
  | 'rebalance_event';

// ---------------------------------------------------------------------------
// Topic routing — ported verbatim from scripts/send-alert.js (DoD §I)
// ---------------------------------------------------------------------------

/**
 * Alert type → TG_TOPIC_* env-var name map.
 * Values are env-var keys; callers resolve the actual thread ID at runtime.
 */
export const TOPIC_MAP: Record<AlertType, string> = {
  trade_proposal: 'TG_TOPIC_RESEARCH',
  sentinel_alert_followup: 'TG_TOPIC_RESEARCH',
  sell_triggered: 'TG_TOPIC_SENTINEL',
  trade_executed: 'TG_TOPIC_EXECUTOR',
  trade_failed: 'TG_TOPIC_EXECUTOR',
  trade_retry: 'TG_TOPIC_EXECUTOR',
  model_failure: 'TG_TOPIC_ALERTS',
  emergency_mode: 'TG_TOPIC_ALERTS',
  rug_warning: 'TG_TOPIC_ALERTS',
  signer_low_balance: 'TG_TOPIC_ALERTS',
  recovered: 'TG_TOPIC_SYSTEM',
  system_health: 'TG_TOPIC_OBSERVER',
  heartbeat_summary: 'TG_TOPIC_SYSTEM',
  portfolio_daily: 'TG_TOPIC_PORTFOLIO',
  rebalance_event: 'TG_TOPIC_PORTFOLIO',
};

/**
 * Alert type → emoji string — ported from `scripts/send-alert.js:EMOJI_MAP`.
 * Unicode escape sequences kept as-is for readability and DoD §I parity.
 */
export const EMOJI_MAP: Record<AlertType, string> = {
  recovered: '✅',
  trade_proposal: '📊',
  trade_executed: '✅',
  trade_failed: '❌',
  trade_retry: '🔄',
  sell_triggered: '🚨',
  sentinel_alert_followup: '📝',
  model_failure: '⚠️',
  emergency_mode: '⚠️',
  rug_warning: '🚨',
  signer_low_balance: '⛽',
  system_health: '📡',
  heartbeat_summary: '📡',
  portfolio_daily: '💰',
  rebalance_event: '⚖️',
};

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when TELEGRAM_BOT_TOKEN is absent and direct API is required. */
export class TelegramBotTokenMissingError extends Error {
  constructor() {
    super('TELEGRAM_BOT_TOKEN is not configured — Telegram Bot API calls are unavailable');
    this.name = 'TelegramBotTokenMissingError';
  }
}

/** Thrown when the Telegram Bot API returns an error. */
export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly description: string,
  ) {
    super(`Telegram API error (${method}): ${description}`);
    this.name = 'TelegramApiError';
  }
}

// ---------------------------------------------------------------------------
// Request/response types
// ---------------------------------------------------------------------------

export interface SendMessageParams {
  chatId: string;
  text: string;
  threadId?: string;
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
}

export interface EditMessageParams {
  chatId: string;
  messageId: number;
  text: string;
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  /**
   * When true, passes `reply_markup: { inline_keyboard: [] }` to Telegram
   * to clear all inline buttons from the message (ported from
   * `scripts/approval-bot.js:editMessageText` which always clears buttons).
   */
  removeInlineKeyboard?: boolean;
}

export interface AnswerCallbackParams {
  callbackQueryId: string;
  text?: string;
  /**
   * When true, Telegram shows the text as an alert dialog rather than a toast.
   * Used by the approval-bot to surface "Unauthorized" and "already processed"
   * messages more prominently (ported from scripts/approval-bot.js:show_alert).
   */
  showAlert?: boolean;
}

export interface GetUpdatesParams {
  offset?: number;
  limit?: number;
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * NestJS injectable adapter for the Telegram Bot API.
 *
 * Token is read lazily (on first call) so boot does not fail when
 * TELEGRAM_BOT_TOKEN is absent (it is optional per SPEC §10).
 */
@Injectable()
export class TelegramAdapter {
  private readonly logger = new Logger(TelegramAdapter.name);

  constructor(private readonly configService: ConfigService) {}

  /** Resolve bot token — throws if absent. ADR-0026: per-field get. */
  private getBotToken(): string {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) throw new TelegramBotTokenMissingError();
    return token;
  }

  /** Build the base URL for a Bot API method. Token is NEVER logged. */
  private buildUrl(method: string): string {
    const token = this.getBotToken();
    return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  }

  /**
   * Call a Telegram Bot API method via POST.
   *
   * The bot token appears in the URL path — it is never logged. The URL
   * is redacted by the logger's `RE_RPC_CREDS` pattern which catches
   * `https://api.telegram.org/bot<token>/...` via the `:user@host` path.
   * For extra safety, we only log the method name, not the full URL.
   *
   * @internal
   */
  private async apiPost<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const url = this.buildUrl(method);
    this.logger.debug(`telegram: calling ${method}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    const json = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) {
      throw new TelegramApiError(method, json.description ?? 'unknown error');
    }
    return json.result as T;
  }

  /**
   * Send a message to a Telegram chat/topic.
   *
   * @param params.chatId - Telegram chat ID.
   * @param params.text - Message text (HTML or Markdown depending on parseMode).
   * @param params.threadId - Optional forum topic thread ID.
   * @param params.parseMode - Text parse mode (default: HTML).
   *
   * @throws {TelegramBotTokenMissingError} if token not configured.
   * @throws {TelegramApiError} on API-level error.
   */
  async sendMessage(params: SendMessageParams, signal?: AbortSignal): Promise<void> {
    const { chatId, text, threadId, parseMode = 'HTML' } = params;
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    };
    if (threadId) {
      body.message_thread_id = threadId;
    }
    await this.apiPost<unknown>('sendMessage', body, signal);
  }

  /**
   * Edit an existing message in a Telegram chat.
   *
   * Used by the approval-bot (PR-F) to update button states after
   * approval/rejection.
   *
   * @param params.removeInlineKeyboard - When true, passes an empty
   *   `inline_keyboard` to clear approval/reject buttons from the message
   *   (mirrors `scripts/approval-bot.js:editMessageText reply_markup` — DoD §I).
   */
  async editMessageText(params: EditMessageParams, signal?: AbortSignal): Promise<void> {
    const { chatId, messageId, text, parseMode = 'HTML', removeInlineKeyboard } = params;
    await this.apiPost<unknown>(
      'editMessageText',
      {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: parseMode,
        ...(removeInlineKeyboard ? { reply_markup: { inline_keyboard: [] } } : {}),
      },
      signal,
    );
  }

  /**
   * Answer a Telegram callback query (inline button press acknowledgement).
   *
   * Used by the approval-bot (PR-F).
   *
   * @param params.showAlert - When true, Telegram shows the text as an alert
   *   dialog (modal) rather than a brief toast — used for "Unauthorized" and
   *   "already processed" acknowledgements (ported from scripts/approval-bot.js).
   */
  async answerCallbackQuery(params: AnswerCallbackParams, signal?: AbortSignal): Promise<void> {
    const { callbackQueryId, text, showAlert } = params;
    await this.apiPost<unknown>(
      'answerCallbackQuery',
      {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
        ...(showAlert ? { show_alert: true } : {}),
      },
      signal,
    );
  }

  /**
   * Long-poll for new Telegram updates (messages, callback queries).
   *
   * Used by the approval-bot (PR-F) for the getUpdates polling loop.
   * Returns an empty array on error rather than throwing — the polling loop
   * must be resilient to transient API errors.
   */
  async getUpdates(params: GetUpdatesParams = {}, signal?: AbortSignal): Promise<unknown[]> {
    const { offset, limit = 100, timeout = 30 } = params;
    try {
      const result = await this.apiPost<unknown[]>(
        'getUpdates',
        { timeout, limit, ...(offset !== undefined ? { offset } : {}) },
        signal,
      );
      return result ?? [];
    } catch (err) {
      this.logger.warn(`telegram: getUpdates failed — ${(err as Error).message}`);
      return [];
    }
  }
}
