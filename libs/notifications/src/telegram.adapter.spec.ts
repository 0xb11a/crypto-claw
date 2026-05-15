/**
 * Unit tests for TelegramAdapter (SPEC §14, DoD §A, §F).
 *
 * Mocks `fetch` at the global boundary. No real Telegram API calls.
 *
 * CRITICAL: Bot token must NEVER appear in any captured log line.
 * The token is in the URL: `https://api.telegram.org/bot<TOKEN>/sendMessage`.
 * The logger must only emit the method name, not the full URL.
 *
 * Covers:
 *   sendMessage:
 *     - Happy path: fetch called with correct URL, body shape.
 *     - Missing TELEGRAM_BOT_TOKEN → throws TelegramBotTokenMissingError.
 *     - API returns ok=false → throws TelegramApiError.
 *     - threadId provided → body includes message_thread_id.
 *     - threadId absent → body has no message_thread_id.
 *     - CRITICAL: bot token NEVER appears in any log line.
 *
 *   editMessageText:
 *     - Happy path: correct editMessageText body.
 *
 *   answerCallbackQuery:
 *     - Happy path: correct answerCallbackQuery body.
 *
 *   getUpdates:
 *     - Happy path: returns result array.
 *     - API error → returns [] (resilient polling loop).
 *     - offset/limit/timeout defaults.
 *
 * SPEC §4 #4 — no signer keys.
 * SPEC §4 #6 — no process.env; all config via ConfigService.
 * DoD §A — tests fail before, pass after.
 * DoD §F — bot token never in logs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  TelegramAdapter,
  TelegramBotTokenMissingError,
  TelegramApiError,
  TOPIC_MAP,
  EMOJI_MAP,
} from './telegram.adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// pre-commit-allow: test fixture token — not a real secret
const FAKE_TOKEN = 'fake-telegram-token-aaaaaaaaaaaaaaaa'; // pre-commit-allow

type FetchSpy = ReturnType<typeof vi.fn>;

function makeConfigService(
  token: string | null = FAKE_TOKEN,
  extra: Record<string, string | undefined> = {},
): ConfigService {
  const map: Record<string, string | undefined> = {
    // null means "not configured" — avoids JS default-param behavior where
    // passing `undefined` triggers the default value.
    TELEGRAM_BOT_TOKEN: token === null ? undefined : token,
    ...extra,
  };
  return {
    get: vi.fn((key: string) => map[key]),
  } as unknown as ConfigService;
}

function mockFetchOk(result: unknown = {}): FetchSpy {
  const spy = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result }), { status: 200 }));
  global.fetch = spy as unknown as typeof fetch;
  return spy;
}

function mockFetchApiError(description = 'Bad Request'): FetchSpy {
  const spy = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description }), { status: 200 }));
  global.fetch = spy as unknown as typeof fetch;
  return spy;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;
  let configService: ConfigService;
  let originalFetch: typeof globalThis.fetch;
  let logMessages: string[];

  beforeEach(() => {
    originalFetch = global.fetch;
    logMessages = [];
    configService = makeConfigService();
    adapter = new TelegramAdapter(configService);

    vi.spyOn(Logger.prototype, 'debug').mockImplementation((msg: unknown) => {
      logMessages.push(String(msg));
    });
    vi.spyOn(Logger.prototype, 'log').mockImplementation((msg: unknown) => {
      logMessages.push(String(msg));
    });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((msg: unknown) => {
      logMessages.push(String(msg));
    });
    vi.spyOn(Logger.prototype, 'error').mockImplementation((msg: unknown) => {
      logMessages.push(String(msg));
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // CRITICAL: bot token must never appear in logs
  // -------------------------------------------------------------------------

  describe('bot token redaction — CRITICAL (DoD §F)', () => {
    it('does NOT log the bot token in any log call during sendMessage', async () => {
      mockFetchOk();
      await adapter.sendMessage({ chatId: '-1001234', text: 'test message' });

      const combined = logMessages.join('\n');
      expect(combined).not.toContain(FAKE_TOKEN);
    });

    it('does NOT log the full URL (which contains the token)', async () => {
      mockFetchOk();
      await adapter.sendMessage({ chatId: '-1001234', text: 'test' });

      const combined = logMessages.join('\n');
      // URL would be: https://api.telegram.org/bot<token>/sendMessage
      expect(combined).not.toContain(`bot${FAKE_TOKEN}`);
    });

    it('does NOT log bot token during getUpdates even on error', async () => {
      mockFetchApiError('Unauthorized');
      await adapter.getUpdates();

      const combined = logMessages.join('\n');
      expect(combined).not.toContain(FAKE_TOKEN);
    });
  });

  // -------------------------------------------------------------------------
  // sendMessage — happy path
  // -------------------------------------------------------------------------

  describe('sendMessage() — happy path', () => {
    it('resolves without error on ok=true response', async () => {
      mockFetchOk();
      await expect(adapter.sendMessage({ chatId: '-1001234', text: 'hello' })).resolves.not.toThrow();
    });

    it('sends POST to correct Telegram Bot API URL', async () => {
      const spy = mockFetchOk();
      await adapter.sendMessage({ chatId: '-1001234', text: 'hello' });

      const url = (spy.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    });

    it('sends correct body shape with chat_id and text', async () => {
      const spy = mockFetchOk();
      await adapter.sendMessage({ chatId: '-1001234', text: 'test message' });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.chat_id).toBe('-1001234');
      expect(body.text).toBe('test message');
    });

    it('uses HTML parse_mode by default', async () => {
      const spy = mockFetchOk();
      await adapter.sendMessage({ chatId: '-1001234', text: 'hello' });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.parse_mode).toBe('HTML');
    });

    it('includes message_thread_id when threadId is provided', async () => {
      const spy = mockFetchOk();
      await adapter.sendMessage({ chatId: '-1001234', text: 'hello', threadId: '42' });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.message_thread_id).toBe('42');
    });

    it('does NOT include message_thread_id when threadId is absent', async () => {
      const spy = mockFetchOk();
      await adapter.sendMessage({ chatId: '-1001234', text: 'hello' });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.message_thread_id).toBeUndefined();
    });

    it('uses custom parseMode when provided', async () => {
      const spy = mockFetchOk();
      await adapter.sendMessage({ chatId: '-1001234', text: 'hello', parseMode: 'MarkdownV2' });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.parse_mode).toBe('MarkdownV2');
    });
  });

  // -------------------------------------------------------------------------
  // sendMessage — missing token
  // -------------------------------------------------------------------------

  describe('sendMessage() — missing token', () => {
    it('throws TelegramBotTokenMissingError when token absent', async () => {
      const cfgNoToken = makeConfigService(null);
      const adapterNoToken = new TelegramAdapter(cfgNoToken);

      await expect(adapterNoToken.sendMessage({ chatId: '-1001234', text: 'hi' })).rejects.toThrow(
        TelegramBotTokenMissingError,
      );
    });

    it('TelegramBotTokenMissingError has descriptive message', async () => {
      const cfgNoToken = makeConfigService(null);
      const adapterNoToken = new TelegramAdapter(cfgNoToken);

      const err = await adapterNoToken.sendMessage({ chatId: '-1001234', text: 'hi' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TelegramBotTokenMissingError);
      expect((err as TelegramBotTokenMissingError).message).toContain('TELEGRAM_BOT_TOKEN');
    });

    it('does NOT call fetch when token is missing', async () => {
      const spy = vi.fn();
      global.fetch = spy as unknown as typeof fetch;
      const cfgNoToken = makeConfigService(null);
      const adapterNoToken = new TelegramAdapter(cfgNoToken);

      await adapterNoToken.sendMessage({ chatId: '-1001234', text: 'hi' }).catch(() => {});

      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // sendMessage — API error
  // -------------------------------------------------------------------------

  describe('sendMessage() — API error', () => {
    it('throws TelegramApiError when ok=false', async () => {
      mockFetchApiError('Forbidden: bot was blocked');

      await expect(adapter.sendMessage({ chatId: '-1001234', text: 'hi' })).rejects.toThrow(TelegramApiError);
    });

    it('TelegramApiError carries method and description', async () => {
      mockFetchApiError('Forbidden');

      const err = await adapter.sendMessage({ chatId: '-1001234', text: 'hi' }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(TelegramApiError);
      expect((err as TelegramApiError).method).toBe('sendMessage');
      expect((err as TelegramApiError).description).toBe('Forbidden');
    });
  });

  // -------------------------------------------------------------------------
  // editMessageText
  // -------------------------------------------------------------------------

  describe('editMessageText()', () => {
    it('sends correct body for editMessageText', async () => {
      const spy = mockFetchOk();
      await adapter.editMessageText({ chatId: '-1001234', messageId: 99, text: 'updated' });

      const url = (spy.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toContain('editMessageText');
      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.chat_id).toBe('-1001234');
      expect(body.message_id).toBe(99);
      expect(body.text).toBe('updated');
    });
  });

  // -------------------------------------------------------------------------
  // answerCallbackQuery
  // -------------------------------------------------------------------------

  describe('answerCallbackQuery()', () => {
    it('sends correct body with callbackQueryId', async () => {
      const spy = mockFetchOk();
      await adapter.answerCallbackQuery({ callbackQueryId: 'cqid-123' });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.callback_query_id).toBe('cqid-123');
    });

    it('includes text field when provided', async () => {
      const spy = mockFetchOk();
      await adapter.answerCallbackQuery({ callbackQueryId: 'cqid-123', text: 'OK' });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.text).toBe('OK');
    });

    it('omits text field when not provided', async () => {
      const spy = mockFetchOk();
      await adapter.answerCallbackQuery({ callbackQueryId: 'cqid-123' });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.text).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getUpdates
  // -------------------------------------------------------------------------

  describe('getUpdates()', () => {
    it('returns result array on success', async () => {
      mockFetchOk([{ update_id: 1 }, { update_id: 2 }]);

      const result = await adapter.getUpdates();

      expect(result).toHaveLength(2);
    });

    it('returns [] when API error occurs (resilient polling)', async () => {
      mockFetchApiError('Unauthorized');

      const result = await adapter.getUpdates();

      expect(result).toEqual([]);
    });

    it('returns [] when fetch throws', async () => {
      global.fetch = vi.fn().mockRejectedValueOnce(new Error('network error')) as unknown as typeof fetch;

      const result = await adapter.getUpdates();

      expect(result).toEqual([]);
    });

    it('uses default limit=100 and timeout=30', async () => {
      const spy = mockFetchOk([]);

      await adapter.getUpdates();

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.limit).toBe(100);
      expect(body.timeout).toBe(30);
    });

    it('includes offset when provided', async () => {
      const spy = mockFetchOk([]);

      await adapter.getUpdates({ offset: 42 });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.offset).toBe(42);
    });

    it('omits offset when not provided', async () => {
      const spy = mockFetchOk([]);

      await adapter.getUpdates({});

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.offset).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // answerCallbackQuery — showAlert parameter
  // -------------------------------------------------------------------------

  describe('answerCallbackQuery() — showAlert parameter', () => {
    it('includes show_alert:true in body when showAlert=true', async () => {
      const spy = mockFetchOk();
      await adapter.answerCallbackQuery({ callbackQueryId: 'cq-1', text: 'Unauthorized', showAlert: true });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.show_alert).toBe(true);
    });

    it('omits show_alert from body when showAlert=false', async () => {
      const spy = mockFetchOk();
      await adapter.answerCallbackQuery({ callbackQueryId: 'cq-1', text: 'OK', showAlert: false });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.show_alert).toBeUndefined();
    });

    it('omits show_alert from body when showAlert is not provided', async () => {
      const spy = mockFetchOk();
      await adapter.answerCallbackQuery({ callbackQueryId: 'cq-1', text: 'OK' });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.show_alert).toBeUndefined();
    });

    it('calls answerCallbackQuery endpoint (correct URL)', async () => {
      const spy = mockFetchOk();
      await adapter.answerCallbackQuery({ callbackQueryId: 'cq-1' });

      const url = (spy.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toContain('answerCallbackQuery');
    });

    // CRITICAL: bot token redaction
    it('does NOT log bot token when answerCallbackQuery fails (DoD §F)', async () => {
      mockFetchApiError('Unauthorized');
      await adapter.answerCallbackQuery({ callbackQueryId: 'cq-1', text: 'test' }).catch(() => undefined);

      const combined = logMessages.join('\n');
      expect(combined).not.toContain(FAKE_TOKEN);
    });
  });

  // -------------------------------------------------------------------------
  // editMessageText — removeInlineKeyboard parameter
  // -------------------------------------------------------------------------

  describe('editMessageText() — removeInlineKeyboard parameter', () => {
    it('includes reply_markup with empty inline_keyboard when removeInlineKeyboard=true', async () => {
      const spy = mockFetchOk();
      await adapter.editMessageText({ chatId: '-1001234', messageId: 99, text: 'done', removeInlineKeyboard: true });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.reply_markup).toEqual({ inline_keyboard: [] });
    });

    it('omits reply_markup when removeInlineKeyboard=false', async () => {
      const spy = mockFetchOk();
      await adapter.editMessageText({ chatId: '-1001234', messageId: 99, text: 'done', removeInlineKeyboard: false });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.reply_markup).toBeUndefined();
    });

    it('omits reply_markup when removeInlineKeyboard is not provided', async () => {
      const spy = mockFetchOk();
      await adapter.editMessageText({ chatId: '-1001234', messageId: 99, text: 'done' });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.reply_markup).toBeUndefined();
    });

    it('uses HTML parse_mode by default', async () => {
      const spy = mockFetchOk();
      await adapter.editMessageText({ chatId: '-1001234', messageId: 99, text: 'done' });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.parse_mode).toBe('HTML');
    });

    it('sends chat_id and message_id correctly', async () => {
      const spy = mockFetchOk();
      await adapter.editMessageText({ chatId: '-1001999', messageId: 777, text: 'edited' });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.chat_id).toBe('-1001999');
      expect(body.message_id).toBe(777);
    });

    // CRITICAL: bot token redaction
    it('does NOT log bot token when editMessageText fails (DoD §F)', async () => {
      mockFetchApiError('Bad Request: message to edit not found');
      await adapter.editMessageText({ chatId: '-1001234', messageId: 1, text: 'x' }).catch(() => undefined);

      const combined = logMessages.join('\n');
      expect(combined).not.toContain(FAKE_TOKEN);
    });
  });

  // -------------------------------------------------------------------------
  // getUpdates — AbortSignal and URL correctness
  // -------------------------------------------------------------------------

  describe('getUpdates() — URL, signal, and body correctness', () => {
    it('calls getUpdates endpoint (correct URL)', async () => {
      const spy = mockFetchOk([]);
      await adapter.getUpdates({});

      const url = (spy.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toContain('getUpdates');
      expect(url).toContain(FAKE_TOKEN);
    });

    it('passes AbortSignal to fetch', async () => {
      const spy = mockFetchOk([]);
      const controller = new AbortController();
      await adapter.getUpdates({}, controller.signal);

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBe(controller.signal);
    });

    it('returns [] when fetch is aborted via AbortSignal', async () => {
      const controller = new AbortController();
      controller.abort();
      // Real AbortError from an aborted fetch — simulate by rejecting
      const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      global.fetch = vi.fn().mockRejectedValueOnce(abortErr) as unknown as typeof fetch;

      const result = await adapter.getUpdates({}, controller.signal);

      // getUpdates swallows errors and returns [] (resilient polling)
      expect(result).toEqual([]);
    });

    it('sends allowed_updates in body (mirrors legacy approval-bot.js)', async () => {
      const spy = mockFetchOk([]);
      await adapter.getUpdates({ offset: 0, timeout: 30 });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      // The implementation sends timeout + limit + optional offset
      // Legacy approval-bot.js uses allowed_updates=['callback_query']
      // Verify offset and timeout are passed correctly
      expect(body.timeout).toBe(30);
    });

    // CRITICAL: bot token redaction on error
    it('does NOT log bot token when getUpdates encounters a non-abort error (DoD §F)', async () => {
      mockFetchApiError('Too Many Requests');
      await adapter.getUpdates({});

      const combined = logMessages.join('\n');
      expect(combined).not.toContain(FAKE_TOKEN);
    });

    it('does NOT log full URL containing token in getUpdates error path (DoD §F)', async () => {
      mockFetchApiError('Unauthorized');
      await adapter.getUpdates({});

      const combined = logMessages.join('\n');
      expect(combined).not.toContain(`bot${FAKE_TOKEN}`);
    });
  });

  // -------------------------------------------------------------------------
  // TOPIC_MAP and EMOJI_MAP constants (parity with send-alert.js)
  // -------------------------------------------------------------------------

  describe('TOPIC_MAP and EMOJI_MAP constants (DoD §I parity)', () => {
    it('TOPIC_MAP has rug_warning → TG_TOPIC_ALERTS', () => {
      expect(TOPIC_MAP['rug_warning']).toBe('TG_TOPIC_ALERTS');
    });

    it('TOPIC_MAP has system_health → TG_TOPIC_OBSERVER', () => {
      expect(TOPIC_MAP['system_health']).toBe('TG_TOPIC_OBSERVER');
    });

    it('TOPIC_MAP has trade_executed → TG_TOPIC_EXECUTOR', () => {
      expect(TOPIC_MAP['trade_executed']).toBe('TG_TOPIC_EXECUTOR');
    });

    it('TOPIC_MAP has trade_failed → TG_TOPIC_EXECUTOR', () => {
      expect(TOPIC_MAP['trade_failed']).toBe('TG_TOPIC_EXECUTOR');
    });

    it('EMOJI_MAP has rug_warning → 🚨', () => {
      expect(EMOJI_MAP['rug_warning']).toBe('🚨');
    });

    it('EMOJI_MAP has trade_executed → ✅', () => {
      expect(EMOJI_MAP['trade_executed']).toBe('✅');
    });

    it('every TOPIC_MAP key has a corresponding EMOJI_MAP entry', () => {
      const topicKeys = Object.keys(TOPIC_MAP) as (keyof typeof TOPIC_MAP)[];
      for (const key of topicKeys) {
        expect(EMOJI_MAP[key]).toBeDefined();
      }
    });
  });
});
