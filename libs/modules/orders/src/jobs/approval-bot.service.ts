/**
 * ApprovalBotService — Continuous long-poll worker for Telegram inline-button callbacks.
 *
 * Ports `scripts/approval-bot.js` into a NestJS `OnApplicationBootstrap` /
 * `OnApplicationShutdown` service (ADR-0027: Continuous-Worker pattern).
 *
 * Lifecycle:
 *   - `onApplicationBootstrap` — starts the `runLoop()` task unless:
 *       * `PAPER_MODE=true` (no human approvals needed in paper mode).
 *       * `TELEGRAM_BOT_TOKEN` is absent (bot cannot poll without a token).
 *   - `onApplicationShutdown` — aborts the in-flight long-poll via AbortController;
 *     waits up to 5 s for the loop to drain before returning so the worker can
 *     exit cleanly within the usual SIGTERM window.
 *
 * Loop semantics (DoD §I — bug-for-bug parity with `scripts/approval-bot.js`):
 *   1. Long-poll `getUpdates` (timeout=30 s, allowed_updates=['callback_query']).
 *   2. For each update that carries a `callback_query`:
 *      a. Verify `from.id === TELEGRAM_OWNER_ID` — unknown senders get an
 *         "Unauthorized" answerCallbackQuery and are skipped.
 *      b. Parse `data` field: "approve:<orderId>" or "reject:<orderId>".
 *      c. Atomic status transition via `OrdersRepository.transitionApproval`.
 *         Returns `{ updated: false }` (P2025 race) → answer "already processed".
 *      d. `answerCallbackQuery` with confirmation toast.
 *      e. `editMessageText` to remove inline keyboard and append decision label.
 *   3. Persist `update_id + 1` offset in `portfolio_meta.approval_bot_offset` after
 *      each batch so restarts never replay the same event.
 *   4. Always write `portfolio_meta.last_approval_bot_at` each iteration.
 *   5. Exponential backoff on error: start 1 s, cap 60 s; reset to 1 s on success.
 *
 * Config reads (ADR-0026 — per-field):
 *   - `TELEGRAM_BOT_TOKEN`  — Required for any Telegram call.
 *   - `TELEGRAM_OWNER_ID`   — Numeric user ID; only this user can approve/reject.
 *   - `TELEGRAM_CHAT_ID`    — Chat/supergroup ID for message editing.
 *   - `PAPER_MODE`          — Skip the loop entirely when true.
 *   - `SAFE_ID`             — Fund identifier for alert footer.
 *
 * SPEC §4 #6 — no `process.env` reads; all config via ConfigService.
 * SPEC §4 #4 — no signer-key env vars read here.
 * ADR-0026   — per-field config access only.
 * ADR-0027   — Continuous-Worker pattern (no BullMQ queue).
 */
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramAdapter, TelegramBotTokenMissingError } from '@cclaw/notifications';
import { SystemService } from '@cclaw/system';
import { OrdersRepository } from '../orders.repository.js';

// ---------------------------------------------------------------------------
// Internal types (mirrors Telegram's callback_query shape)
// ---------------------------------------------------------------------------

interface TelegramFrom {
  id: number;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramFrom;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Separator line ported from scripts/approval-bot.js. */
const SEP = '────────────────';

/**
 * AbortSignal-aware sleep.
 *
 * Resolves immediately when the signal is aborted so the shutdown path
 * does not block for the full `ms` duration.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Build edited message text — mirrors `buildEditedText` from legacy script.
 *
 * Appends a decision label to the TRADE PROPOSAL header and inserts a
 * "Approved/Rejected by human at <ts>" line before the fund footer.
 * Falls back to appending text at the end if neither regex matches (e.g.
 * the message was already edited or has a different format).
 */
function buildEditedText(
  originalText: string,
  action: 'approve' | 'reject',
  timestamp: string,
  safeId: string,
): string {
  const statusLabel = action === 'approve' ? 'APPROVED ✅' : 'REJECTED ❌';
  const byLine = action === 'approve' ? `Approved by human at ${timestamp}` : `Rejected by human at ${timestamp}`;

  let edited = originalText.replace(/📊 TRADE PROPOSAL/, `📊 TRADE PROPOSAL — ${statusLabel}`);

  // Try to insert the byLine before the fund footer line.
  const footerPattern = new RegExp(`(${SEP}\nFund: .*)$`);
  if (footerPattern.test(edited)) {
    edited = edited.replace(footerPattern, `${SEP}\n${byLine}\nFund: ${safeId}`);
  } else {
    // Fallback: append at end.
    edited = `${edited}\n${byLine}`;
  }

  return edited;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Continuous Telegram approval-bot service (ADR-0027).
 *
 * Started by `onApplicationBootstrap`; stopped cleanly by `onApplicationShutdown`.
 * Registered as a provider in `OrdersModule.forWorker()`.
 */
@Injectable()
export class ApprovalBotService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ApprovalBotService.name);
  private readonly abortController = new AbortController();
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly telegram: TelegramAdapter,
    private readonly systemService: SystemService,
    private readonly ordersRepository: OrdersRepository,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle hooks
  // ---------------------------------------------------------------------------

  async onApplicationBootstrap(): Promise<void> {
    // Skip in paper mode — no human approvals in paper mode.
    const paperMode = this.configService.get<boolean | string>('PAPER_MODE');
    if (paperMode === true || paperMode === 'true') {
      this.logger.log('approval-bot: PAPER_MODE=true — skipping startup');
      return;
    }

    // Skip if bot token is absent — the adapter will throw on first call anyway,
    // but fail early with a clear log rather than a cryptic error in the loop.
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken) {
      this.logger.log('approval-bot: TELEGRAM_BOT_TOKEN not set — skipping startup');
      return;
    }

    const ownerId = this.resolveOwnerId();
    if (ownerId === null) {
      this.logger.warn(
        'approval-bot: TELEGRAM_OWNER_ID not set — approval bot requires owner verification; skipping startup',
      );
      return;
    }

    this.logger.log('approval-bot: starting long-poll loop');
    this.loopPromise = this.runLoop(this.abortController.signal);
  }

  async onApplicationShutdown(_signal?: string): Promise<void> {
    this.abortController.abort();
    if (this.loopPromise) {
      // Wait at most 5 s for the in-flight poll to cancel.
      await Promise.race([this.loopPromise, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    }
    this.logger.log('approval-bot: loop stopped');
  }

  // ---------------------------------------------------------------------------
  // Config helpers (ADR-0026 — per-field)
  // ---------------------------------------------------------------------------

  private resolveOwnerId(): number | null {
    const raw = this.configService.get<string>('TELEGRAM_OWNER_ID');
    if (!raw) return null;
    const id = Number(raw);
    return isNaN(id) ? null : id;
  }

  private getChatId(): string | undefined {
    return this.configService.get<string>('TELEGRAM_CHAT_ID');
  }

  private getSafeId(): string {
    return this.configService.get<string>('SAFE_ID') ?? 'unknown';
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  private async runLoop(signal: AbortSignal): Promise<void> {
    // Restore offset from last run so we never replay events after a restart.
    let offset = await this.loadOffset();
    let backoffMs = 1_000;

    this.logger.log(`approval-bot: polling from offset=${offset}`);

    while (!signal.aborted) {
      try {
        // Long-poll — `timeout=30` means Telegram holds the connection open
        // for up to 30 s if there are no updates; the AbortSignal cancels
        // the in-flight fetch immediately on SIGTERM.
        //
        // Abort path note: TelegramAdapter.getUpdates catches AbortError
        // internally and returns []. The loop therefore exits via the next
        // `while (!signal.aborted)` check rather than the catch block below.
        // Both setMeta writes after this call still execute on the aborted
        // tick but complete in milliseconds, well within the 5 s shutdown
        // budget. If we ever need stricter shutdown promptness, add an
        // explicit `if (signal.aborted) return;` here.
        const rawUpdates = await this.telegram.getUpdates({ offset, limit: 100, timeout: 30 }, signal);

        backoffMs = 1_000; // reset on successful poll

        const updates = rawUpdates as TelegramUpdate[];

        for (const update of updates) {
          const nextOffset = update.update_id + 1;
          if (update.callback_query) {
            await this.handleCallback(update.callback_query);
          }
          // Advance offset regardless of whether we handled the update so we
          // never stall on a non-callback_query update type.
          if (nextOffset > offset) offset = nextOffset;
        }

        // Persist offset only when there was at least one update.
        if (updates.length > 0) {
          await this.systemService.setMeta({ key: 'approval_bot_offset', value: String(offset) });
        }

        // Always write health timestamp.
        await this.systemService.setMeta({
          key: 'last_approval_bot_at',
          value: new Date().toISOString(),
        });
      } catch (err) {
        if (signal.aborted) return;

        const msg = (err as Error).message?.slice(0, 100) ?? 'unknown error';
        this.logger.error(`approval-bot: poll failed — ${msg}; backoff=${backoffMs}ms`);

        await sleep(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Callback handler
  // ---------------------------------------------------------------------------

  /**
   * Process a single Telegram callback_query event.
   *
   * Authorization, parsing, order transition, and message editing all happen
   * here. Any sub-step error is caught and answered to Telegram so the callback
   * is not left pending (which would cause Telegram to show a loading spinner
   * to the operator indefinitely).
   */
  private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const callbackId = query.id;
    const userId = query.from?.id;
    const data = query.data;
    const message = query.message;

    // Security: only the configured fund owner can approve/reject.
    const ownerId = this.resolveOwnerId();
    if (ownerId === null || userId !== ownerId) {
      this.logger.warn(`approval-bot: unauthorized callback from user=${userId}`);
      try {
        // show_alert=true — legacy parity (approval-bot.js line 115)
        await this.telegram.answerCallbackQuery({ callbackQueryId: callbackId, text: 'Unauthorized', showAlert: true });
      } catch {
        // best-effort
      }
      return;
    }

    // Parse callback data: "approve:<orderId>" or "reject:<orderId>".
    if (!data || !data.includes(':')) {
      await this.safeAnswer(callbackId, 'Invalid action');
      return;
    }

    const colonIdx = data.indexOf(':');
    const action = data.slice(0, colonIdx) as 'approve' | 'reject';
    const orderId = data.slice(colonIdx + 1);

    if (action !== 'approve' && action !== 'reject') {
      await this.safeAnswer(callbackId, 'Invalid action');
      return;
    }

    const toStatus = action === 'approve' ? 'approved' : 'rejected';
    const approvedBy = 'telegram';

    // Atomic state transition — guards against double-clicks and race with executor.
    let result: Awaited<ReturnType<OrdersRepository['transitionApproval']>>;
    try {
      result = await this.ordersRepository.transitionApproval(orderId, 'pending', toStatus, approvedBy);
    } catch (err) {
      this.logger.error(`approval-bot: DB error for order=${orderId} — ${(err as Error).message}`);
      await this.safeAnswer(callbackId, 'Error processing request');
      return;
    }

    if (!result.updated) {
      // Order was already acted on (race: executor, duplicate click, legacy bot).
      // show_alert=true — legacy parity (approval-bot.js line 136-139)
      await this.safeAnswer(callbackId, 'Order already processed', true);
      this.logger.log(`approval-bot: ${action} ${orderId} — already processed (P2025 race)`);
      return;
    }

    const order = result.order!;
    const actionVerb = action === 'approve' ? 'Approved' : 'Rejected';
    const toastText =
      action === 'approve' ? `Approved $${order.symbol} — executor will process shortly` : `Rejected $${order.symbol}`;

    await this.safeAnswer(callbackId, toastText);

    // Edit the original message to remove the inline keyboard and show the result.
    if (message) {
      const chatId = this.getChatId() ?? String(message.chat.id);
      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      const editedText = buildEditedText(message.text ?? '', action, timestamp, this.getSafeId());

      try {
        await this.telegram.editMessageText({
          chatId,
          messageId: message.message_id,
          text: editedText,
          parseMode: 'HTML',
          // Legacy parity: remove inline keyboard buttons after approval/rejection.
          // Matches `reply_markup: { inline_keyboard: [] }` in approval-bot.js:154.
          removeInlineKeyboard: true,
        });
      } catch (err) {
        // Editing may fail if the message is too old (>48h) or the bot lacks
        // the necessary permission. Non-fatal — log and continue.
        if (!(err instanceof TelegramBotTokenMissingError)) {
          this.logger.warn(`approval-bot: failed to edit message — ${(err as Error).message}`);
        }
      }
    }

    this.logger.log(
      `approval-bot: ${actionVerb} order=${orderId} symbol=${order.symbol} chain=${order.chain ?? 'unknown'}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Persistence helper
  // ---------------------------------------------------------------------------

  private async loadOffset(): Promise<number> {
    try {
      const meta = await this.systemService.getMeta('approval_bot_offset');
      const val = Number(meta.value);
      return isNaN(val) ? 0 : val;
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  /** Answer a Telegram callback query — swallows errors (best-effort). */
  private async safeAnswer(callbackQueryId: string, text: string, showAlert = false): Promise<void> {
    try {
      await this.telegram.answerCallbackQuery({ callbackQueryId, text, showAlert });
    } catch {
      // best-effort — do not crash the loop
    }
  }
}
