/**
 * ApprovalBotService unit tests (P3g3 PR-F).
 *
 * Spec: ADR-0027 (Continuous-Worker pattern), SPEC §8, DoD §A, §I.
 *
 * Test strategy for the async loop:
 *   ApprovalBotService.onApplicationBootstrap() starts the runLoop() coroutine
 *   but does NOT await it (it's fire-and-forget, stored in loopPromise). This
 *   means the loop has not yet executed when onApplicationBootstrap returns.
 *   Tests that need to observe behaviour INSIDE the loop must:
 *     1. Call onApplicationBootstrap().
 *     2. Flush microtasks (await flushMicrotasks()) until the mock has been called.
 *     3. Allow the loop to complete its batch processing.
 *     4. Call onApplicationShutdown() to abort.
 *
 *   The `runUntilFirstPoll` helper encapsulates this pattern — it boots the
 *   service, flushes until getUpdates is called at least N times, then shuts
 *   down. Any assertions on mock call counts / arguments are made after
 *   runUntilFirstPoll returns.
 *
 * Bootstrap guards:
 *   - PAPER_MODE=true → loop never starts (no getUpdates calls).
 *   - PAPER_MODE='true' (string) → same.
 *   - TELEGRAM_BOT_TOKEN absent → loop never starts.
 *   - TELEGRAM_OWNER_ID absent → loop never starts.
 *   - TELEGRAM_OWNER_ID non-numeric → loop never starts.
 *
 * Authorization:
 *   - callback_query.from.id !== TELEGRAM_OWNER_ID → answerCallbackQuery("Unauthorized", showAlert:true); no DB write.
 *   - callback_query.from.id === TELEGRAM_OWNER_ID → proceeds.
 *
 * Data parsing:
 *   - data field missing → answerCallbackQuery("Invalid action"); no DB write.
 *   - data without colon → answerCallbackQuery("Invalid action"); no DB write.
 *   - action not "approve" or "reject" → answerCallbackQuery("Invalid action"); no DB write.
 *   - orderId with colons ("some-id-with:colons") → splits at FIRST colon only.
 *
 * Approve path:
 *   - transitionApproval called with (id, 'pending', 'approved', 'telegram').
 *   - { updated: true } → answerCallbackQuery(toast); editMessageText with removeInlineKeyboard:true.
 *   - { updated: false } (P2025) → answerCallbackQuery("Order already processed", showAlert:true); no editMessageText.
 *
 * Reject path:
 *   - transitionApproval called with (id, 'pending', 'rejected', 'telegram').
 *   - { updated: true } → answerCallbackQuery(toast); editMessageText called.
 *
 * Offset persistence:
 *   - Non-empty batch → setMeta called with ('approval_bot_offset', String(maxId+1)).
 *   - Empty batch → setMeta NOT called for offset key.
 *   - last_approval_bot_at written every iteration regardless.
 *
 * Initial offset load:
 *   - getMeta returns numeric string → used as starting offset.
 *   - getMeta throws → offset defaults to 0.
 *   - getMeta returns non-numeric → offset defaults to 0.
 *
 * Exponential backoff:
 *   - First error → sleep(1000); backoff becomes 2000.
 *   - Third consecutive error → sleep(4000).
 *   - Backoff cap at 60_000 ms.
 *   - Backoff resets to 1000 on success after escalation.
 *
 * AbortSignal cancellation:
 *   - onApplicationShutdown() aborts → getUpdates signal becomes aborted; loop exits.
 *   - AbortError mid-poll → loop exits cleanly without retry.
 *
 * Non-callback_query updates:
 *   - message/channel_post updates → no DB write; offset still advances.
 *
 * Error resilience:
 *   - transitionApproval throws non-P2025 error → answerCallbackQuery("Error processing request") + log; loop continues.
 *   - editMessageText throws (e.g. 400 48h-old message) → warn logged; DB write still applied; loop continues.
 *   - TELEGRAM_CHAT_ID absent → falls back to message.chat.id for editMessageText.
 *
 * buildEditedText content (indirectly via handleCallback):
 *   - approve: header contains "APPROVED ✅", byLine "Approved by human at".
 *   - reject: header contains "REJECTED ❌", byLine "Rejected by human at".
 *   - Text without matching footer → fallback: byLine appended at end.
 *
 * ADR-0027 shape:
 *   - Service has NO process() method (not a BullMQ WorkerHost).
 *
 * SPEC §4 #4 — no signer keys.
 * SPEC §4 #6 — no process.env; all config via ConfigService.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ApprovalBotService } from './approval-bot.service.js';
import type { TelegramAdapter } from '@cclaw/notifications';
import type { SystemService } from '@cclaw/system';
import type { OrdersRepository } from '../orders.repository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    PAPER_MODE: false,
    TELEGRAM_BOT_TOKEN: 'test-bot-token-aabbccdd1122', // pre-commit-allow
    TELEGRAM_OWNER_ID: '12345',
    TELEGRAM_CHAT_ID: '-1001234567890',
    SAFE_ID: 'test-fund',
  };
  const merged = { ...defaults, ...overrides };
  return {
    get: vi.fn((key: string) => merged[key]),
  } as unknown as ConfigService;
}

function makeSystem(offsetValue = '0'): SystemService {
  return {
    getMeta: vi.fn().mockResolvedValue({ key: 'approval_bot_offset', value: offsetValue }),
    setMeta: vi.fn().mockResolvedValue({ ok: true, key: '', value: '' }),
  } as unknown as SystemService;
}

function makeRepo(
  result: { updated: boolean; order?: { id: string; symbol: string; chain: string } } = {
    updated: true,
    order: { id: 'ord-1', symbol: 'TEST', chain: 'base' },
  },
): OrdersRepository {
  return {
    transitionApproval: vi.fn().mockResolvedValue(result),
  } as unknown as OrdersRepository;
}

/** Build a callback_query update. */
function makeCallbackUpdate(opts: {
  updateId?: number;
  userId?: number;
  callbackId?: string;
  data?: string;
  messageText?: string;
  chatId?: number;
  messageId?: number;
}) {
  return {
    update_id: opts.updateId ?? 1,
    callback_query: {
      id: opts.callbackId ?? 'cq-1',
      from: { id: opts.userId ?? 12345 },
      data: opts.data ?? 'approve:ord-1',
      message: {
        message_id: opts.messageId ?? 99,
        chat: { id: opts.chatId ?? -1001234567890 },
        text: opts.messageText ?? '📊 TRADE PROPOSAL\nSome content\n────────────────\nFund: test-fund',
      },
    },
  };
}

/** Build a non-callback update (message type). */
function makeMessageUpdate(updateId = 2) {
  return { update_id: updateId, message: { message_id: 10, text: 'hello' } };
}

/**
 * Flush microtasks (up to maxTicks iterations) until the predicate is satisfied.
 *
 * The approval-bot loop is an async while-loop that runs in the background.
 * After onApplicationBootstrap() returns, the loop hasn't executed yet.
 * Each `await` in the loop releases control; flushing microtasks (via a chain
 * of Promise.resolve()) lets the loop make progress.
 */
async function flushUntil(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
}

/**
 * Core test helper: boot the service, let the loop run until `getUpdates`
 * has been called at least `minPollCalls` times, then shut down and return.
 *
 * After this function returns, make assertions on mock call counts.
 */
async function runUntilPolled(
  service: ApprovalBotService,
  getUpdatesMock: ReturnType<typeof vi.fn>,
  minPollCalls = 1,
): Promise<void> {
  await service.onApplicationBootstrap();
  await flushUntil(() => getUpdatesMock.mock.calls.length >= minPollCalls);
  await service.onApplicationShutdown();
  // Additional flush after shutdown to let final microtasks settle
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Suppress Logger noise in tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ADR-0027 shape invariant
// ---------------------------------------------------------------------------

describe('ApprovalBotService — ADR-0027 shape invariant', () => {
  it('is defined', () => {
    const getUpdates = vi.fn().mockResolvedValue([]);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), makeRepo());
    expect(service).toBeDefined();
  });

  it('has onApplicationBootstrap() lifecycle method', () => {
    const service = new ApprovalBotService(
      makeConfig(),
      {
        getUpdates: vi.fn(),
        answerCallbackQuery: vi.fn(),
        editMessageText: vi.fn(),
        sendMessage: vi.fn(),
      } as unknown as TelegramAdapter,
      makeSystem(),
      makeRepo(),
    );
    expect(typeof service.onApplicationBootstrap).toBe('function');
  });

  it('has onApplicationShutdown() lifecycle method', () => {
    const service = new ApprovalBotService(
      makeConfig(),
      {
        getUpdates: vi.fn(),
        answerCallbackQuery: vi.fn(),
        editMessageText: vi.fn(),
        sendMessage: vi.fn(),
      } as unknown as TelegramAdapter,
      makeSystem(),
      makeRepo(),
    );
    expect(typeof service.onApplicationShutdown).toBe('function');
  });

  it('does NOT have a process() method — NOT a BullMQ WorkerHost (ADR-0027)', () => {
    const service = new ApprovalBotService(
      makeConfig(),
      {
        getUpdates: vi.fn(),
        answerCallbackQuery: vi.fn(),
        editMessageText: vi.fn(),
        sendMessage: vi.fn(),
      } as unknown as TelegramAdapter,
      makeSystem(),
      makeRepo(),
    );
    expect((service as unknown as { process?: unknown }).process).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bootstrap guards
// ---------------------------------------------------------------------------

describe('ApprovalBotService — bootstrap guards', () => {
  it('skips startup when PAPER_MODE=true (boolean)', async () => {
    const getUpdates = vi.fn().mockResolvedValue([]);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig({ PAPER_MODE: true }), telegram, makeSystem(), makeRepo());
    await service.onApplicationBootstrap();
    await service.onApplicationShutdown();
    await flushUntil(() => true, 10);
    expect(getUpdates).not.toHaveBeenCalled();
  });

  it('skips startup when PAPER_MODE="true" (string)', async () => {
    const getUpdates = vi.fn().mockResolvedValue([]);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig({ PAPER_MODE: 'true' }), telegram, makeSystem(), makeRepo());
    await service.onApplicationBootstrap();
    await service.onApplicationShutdown();
    await flushUntil(() => true, 10);
    expect(getUpdates).not.toHaveBeenCalled();
  });

  it('skips startup when TELEGRAM_BOT_TOKEN is absent', async () => {
    const getUpdates = vi.fn().mockResolvedValue([]);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(
      makeConfig({ TELEGRAM_BOT_TOKEN: undefined }),
      telegram,
      makeSystem(),
      makeRepo(),
    );
    await service.onApplicationBootstrap();
    await service.onApplicationShutdown();
    await flushUntil(() => true, 10);
    expect(getUpdates).not.toHaveBeenCalled();
  });

  it('skips startup when TELEGRAM_BOT_TOKEN is empty string', async () => {
    const getUpdates = vi.fn().mockResolvedValue([]);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig({ TELEGRAM_BOT_TOKEN: '' }), telegram, makeSystem(), makeRepo());
    await service.onApplicationBootstrap();
    await service.onApplicationShutdown();
    await flushUntil(() => true, 10);
    expect(getUpdates).not.toHaveBeenCalled();
  });

  it('skips startup when TELEGRAM_OWNER_ID is absent', async () => {
    const getUpdates = vi.fn().mockResolvedValue([]);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(
      makeConfig({ TELEGRAM_OWNER_ID: undefined }),
      telegram,
      makeSystem(),
      makeRepo(),
    );
    await service.onApplicationBootstrap();
    await service.onApplicationShutdown();
    await flushUntil(() => true, 10);
    expect(getUpdates).not.toHaveBeenCalled();
  });

  it('skips startup when TELEGRAM_OWNER_ID is non-numeric string', async () => {
    const getUpdates = vi.fn().mockResolvedValue([]);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(
      makeConfig({ TELEGRAM_OWNER_ID: 'not-a-number' }),
      telegram,
      makeSystem(),
      makeRepo(),
    );
    await service.onApplicationBootstrap();
    await service.onApplicationShutdown();
    await flushUntil(() => true, 10);
    expect(getUpdates).not.toHaveBeenCalled();
  });

  it('does NOT skip when all required config is present — getUpdates is called', async () => {
    // getUpdates blocks until signal aborted: guarantees the loop started and polled
    const getUpdates = vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      return new Promise<unknown[]>((_, reject) => {
        if (signal.aborted) {
          reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
        });
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), makeRepo());
    await service.onApplicationBootstrap();
    await flushUntil(() => getUpdates.mock.calls.length >= 1);
    await service.onApplicationShutdown();
    expect(getUpdates).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Offset persistence on startup
// ---------------------------------------------------------------------------

describe('ApprovalBotService — initial offset load', () => {
  it('loads offset from getMeta on startup and passes it to getUpdates', async () => {
    const system = makeSystem('500');
    let callCount = 0;
    const getUpdates = vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) return Promise.resolve([]);
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, system, makeRepo());
    await runUntilPolled(service, getUpdates);

    expect(getUpdates).toHaveBeenCalledWith(expect.objectContaining({ offset: 500 }), expect.anything());
  });

  it('falls back to offset=0 when getMeta throws', async () => {
    const system = {
      getMeta: vi.fn().mockRejectedValue(new Error('DB unavailable')),
      setMeta: vi.fn().mockResolvedValue({ ok: true, key: '', value: '' }),
    } as unknown as SystemService;

    let callCount = 0;
    const getUpdates = vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) return Promise.resolve([]);
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, system, makeRepo());
    await runUntilPolled(service, getUpdates);

    expect(getUpdates).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }), expect.anything());
  });

  it('falls back to offset=0 when getMeta returns non-numeric value', async () => {
    const system = makeSystem('not-a-number');
    let callCount = 0;
    const getUpdates = vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) return Promise.resolve([]);
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, system, makeRepo());
    await runUntilPolled(service, getUpdates);

    expect(getUpdates).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }), expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Health meta — last_approval_bot_at written every iteration
// ---------------------------------------------------------------------------

describe('ApprovalBotService — health meta', () => {
  it('writes last_approval_bot_at on each poll iteration (empty batch)', async () => {
    const system = makeSystem('0');
    let callCount = 0;
    const getUpdates = vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) return Promise.resolve([]);
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, system, makeRepo());
    await runUntilPolled(service, getUpdates);

    expect(system.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'last_approval_bot_at' }));
  });

  it('writes last_approval_bot_at when batch has updates too', async () => {
    const system = makeSystem('0');
    const update = makeCallbackUpdate({ updateId: 1 });
    let callCount = 0;
    const getUpdates = vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) return Promise.resolve([update]);
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, system, makeRepo());
    await runUntilPolled(service, getUpdates);

    expect(system.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'last_approval_bot_at' }));
  });
});

// ---------------------------------------------------------------------------
// Offset persistence after non-empty batch
// ---------------------------------------------------------------------------

describe('ApprovalBotService — offset persistence', () => {
  it('calls setMeta(approval_bot_offset, String(maxId+1)) after non-empty batch', async () => {
    const system = makeSystem('0');
    const update = makeCallbackUpdate({ updateId: 42 });
    let callCount = 0;
    const getUpdates = vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) return Promise.resolve([update]);
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, system, makeRepo());
    await runUntilPolled(service, getUpdates);

    expect(system.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'approval_bot_offset', value: '43' }));
  });

  it('does NOT call setMeta for offset key when batch is empty', async () => {
    const system = makeSystem('0');
    let callCount = 0;
    const getUpdates = vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) return Promise.resolve([]); // empty
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, system, makeRepo());
    await runUntilPolled(service, getUpdates);

    const offsetCalls = (system.setMeta as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[0] as { key: string }).key === 'approval_bot_offset',
    );
    expect(offsetCalls).toHaveLength(0);
  });

  it('advances to max update_id + 1 across all updates in a batch', async () => {
    const system = makeSystem('0');
    const updates = [makeCallbackUpdate({ updateId: 10, data: 'approve:ord-1' }), makeMessageUpdate(15)];
    let callCount = 0;
    const getUpdates = vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) return Promise.resolve(updates);
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, system, makeRepo());
    await runUntilPolled(service, getUpdates);

    expect(system.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'approval_bot_offset', value: '16' }));
  });
});

// ---------------------------------------------------------------------------
// getUpdates call params
// ---------------------------------------------------------------------------

describe('ApprovalBotService — getUpdates call params', () => {
  it('calls getUpdates with timeout=30, limit=100, offset from loaded state', async () => {
    const system = makeSystem('0');
    let callCount = 0;
    const getUpdates = vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) return Promise.resolve([]);
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, system, makeRepo());
    await runUntilPolled(service, getUpdates);

    expect(getUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 30, limit: 100, offset: 0 }),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Authorization check
// ---------------------------------------------------------------------------

describe('ApprovalBotService — authorization', () => {
  it('rejects callback from non-owner with answerCallbackQuery("Unauthorized", showAlert:true)', async () => {
    const update = makeCallbackUpdate({ userId: 99999, callbackId: 'cq-unauth' });
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    let callCount = 0;
    const getUpdates = vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) return Promise.resolve([update]);
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery,
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo();
    const service = new ApprovalBotService(makeConfig({ TELEGRAM_OWNER_ID: '12345' }), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ callbackQueryId: 'cq-unauth', text: 'Unauthorized', showAlert: true }),
    );
    expect(repo.transitionApproval).not.toHaveBeenCalled();
  });

  it('does not write to DB when unauthorized', async () => {
    const update = makeCallbackUpdate({ userId: 99999 });
    let callCount = 0;
    const getUpdates = vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) return Promise.resolve([update]);
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo();
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(repo.transitionApproval).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Data parsing
// ---------------------------------------------------------------------------

describe('ApprovalBotService — data parsing', () => {
  function makeGetUpdatesOnce(batch: unknown[]): ReturnType<typeof vi.fn> {
    let callCount = 0;
    return vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) return Promise.resolve(batch);
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });
  }

  it('answers Invalid action when data field is missing', async () => {
    const update: unknown = {
      update_id: 1,
      callback_query: {
        id: 'cq-bad',
        from: { id: 12345 },
        // No data field
        message: { message_id: 1, chat: { id: -100 } },
      },
    };
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const getUpdates = makeGetUpdatesOnce([update]);
    const telegram = {
      getUpdates,
      answerCallbackQuery,
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo();
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Invalid action' }));
    expect(repo.transitionApproval).not.toHaveBeenCalled();
  });

  it('answers Invalid action when data has no colon', async () => {
    const update = makeCallbackUpdate({ data: 'approveorderId' });
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const getUpdates = makeGetUpdatesOnce([update]);
    const telegram = {
      getUpdates,
      answerCallbackQuery,
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo();
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Invalid action' }));
    expect(repo.transitionApproval).not.toHaveBeenCalled();
  });

  it('answers Invalid action when action is not approve or reject', async () => {
    const update = makeCallbackUpdate({ data: 'cancel:ord-1' });
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const getUpdates = makeGetUpdatesOnce([update]);
    const telegram = {
      getUpdates,
      answerCallbackQuery,
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo();
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Invalid action' }));
    expect(repo.transitionApproval).not.toHaveBeenCalled();
  });

  it('correctly splits orderId at FIRST colon when orderId contains colons', async () => {
    const update = makeCallbackUpdate({ data: 'approve:some-id-with:colons:inside' });
    const getUpdates = makeGetUpdatesOnce([update]);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo();
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(repo.transitionApproval).toHaveBeenCalledWith(
      'some-id-with:colons:inside',
      'pending',
      'approved',
      'telegram',
    );
  });
});

// ---------------------------------------------------------------------------
// Shared: one-batch getUpdates factory
// ---------------------------------------------------------------------------

function makeGetUpdatesOnce(batch: unknown[]): ReturnType<typeof vi.fn> {
  let callCount = 0;
  return vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
    callCount++;
    if (callCount === 1) return Promise.resolve(batch);
    return new Promise<unknown[]>((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
    });
  });
}

// ---------------------------------------------------------------------------
// Approve path
// ---------------------------------------------------------------------------

describe('ApprovalBotService — approve path', () => {
  it('calls transitionApproval(id, pending, approved, telegram)', async () => {
    const update = makeCallbackUpdate({ data: 'approve:order-123' });
    const getUpdates = makeGetUpdatesOnce([update]);
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery,
      editMessageText,
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo({ updated: true, order: { id: 'order-123', symbol: 'BONK', chain: 'solana' } });
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(repo.transitionApproval).toHaveBeenCalledWith('order-123', 'pending', 'approved', 'telegram');
  });

  it('calls answerCallbackQuery with toast containing symbol on successful approve', async () => {
    const update = makeCallbackUpdate({ data: 'approve:order-123' });
    const getUpdates = makeGetUpdatesOnce([update]);
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery,
      editMessageText: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo({ updated: true, order: { id: 'order-123', symbol: 'BONK', chain: 'solana' } });
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    const toastCall = answerCallbackQuery.mock.calls.find((c: unknown[]) =>
      (c[0] as { text: string }).text?.includes('BONK'),
    );
    expect(toastCall).toBeDefined();
  });

  it('calls editMessageText with removeInlineKeyboard:true on successful approve', async () => {
    const update = makeCallbackUpdate({ data: 'approve:order-123' });
    const getUpdates = makeGetUpdatesOnce([update]);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo({ updated: true, order: { id: 'order-123', symbol: 'BONK', chain: 'solana' } });
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(editMessageText).toHaveBeenCalledWith(expect.objectContaining({ removeInlineKeyboard: true }));
  });

  it('does NOT call editMessageText when transitionApproval returns { updated: false } (P2025 race)', async () => {
    const update = makeCallbackUpdate({ data: 'approve:order-123' });
    const getUpdates = makeGetUpdatesOnce([update]);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo({ updated: false });
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(editMessageText).not.toHaveBeenCalled();
  });

  it('answers "Order already processed" with showAlert:true on P2025 race', async () => {
    const update = makeCallbackUpdate({ data: 'approve:order-123', callbackId: 'cq-stale' });
    const getUpdates = makeGetUpdatesOnce([update]);
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery,
      editMessageText: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo({ updated: false });
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Order already processed', showAlert: true }),
    );
  });

  it('uses TELEGRAM_CHAT_ID config when available for editMessageText', async () => {
    const update = makeCallbackUpdate({ data: 'approve:order-123', chatId: -9999 });
    const getUpdates = makeGetUpdatesOnce([update]);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo({ updated: true, order: { id: 'order-123', symbol: 'X', chain: 'base' } });
    const service = new ApprovalBotService(
      makeConfig({ TELEGRAM_CHAT_ID: '-1001111111111' }),
      telegram,
      makeSystem(),
      repo,
    );
    await runUntilPolled(service, getUpdates);

    expect(editMessageText).toHaveBeenCalledWith(expect.objectContaining({ chatId: '-1001111111111' }));
  });

  it('falls back to message.chat.id when TELEGRAM_CHAT_ID is absent', async () => {
    const update = makeCallbackUpdate({ data: 'approve:order-123', chatId: -8888999 });
    const getUpdates = makeGetUpdatesOnce([update]);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo({ updated: true, order: { id: 'order-123', symbol: 'X', chain: 'base' } });
    const service = new ApprovalBotService(makeConfig({ TELEGRAM_CHAT_ID: undefined }), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(editMessageText).toHaveBeenCalledWith(expect.objectContaining({ chatId: '-8888999' }));
  });
});

// ---------------------------------------------------------------------------
// Reject path
// ---------------------------------------------------------------------------

describe('ApprovalBotService — reject path', () => {
  it('calls transitionApproval(id, pending, rejected, telegram)', async () => {
    const update = makeCallbackUpdate({ data: 'reject:order-456' });
    const getUpdates = makeGetUpdatesOnce([update]);
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery,
      editMessageText,
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo({ updated: true, order: { id: 'order-456', symbol: 'PEPE', chain: 'base' } });
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(repo.transitionApproval).toHaveBeenCalledWith('order-456', 'pending', 'rejected', 'telegram');
  });

  it('calls editMessageText after successful reject', async () => {
    const update = makeCallbackUpdate({ data: 'reject:order-456' });
    const getUpdates = makeGetUpdatesOnce([update]);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo({ updated: true, order: { id: 'order-456', symbol: 'PEPE', chain: 'base' } });
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(editMessageText).toHaveBeenCalledOnce();
  });

  it('toast text contains symbol for reject', async () => {
    const update = makeCallbackUpdate({ data: 'reject:order-456' });
    const getUpdates = makeGetUpdatesOnce([update]);
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery,
      editMessageText: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo({ updated: true, order: { id: 'order-456', symbol: 'PEPE', chain: 'base' } });
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    const toastCall = answerCallbackQuery.mock.calls.find((c: unknown[]) =>
      (c[0] as { text: string }).text?.includes('PEPE'),
    );
    expect(toastCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// editMessageText content (buildEditedText behavior)
// ---------------------------------------------------------------------------

describe('ApprovalBotService — editMessageText content (buildEditedText)', () => {
  it('approve: edited text contains "APPROVED ✅" in header', async () => {
    const msgText = '📊 TRADE PROPOSAL\nSome content\n────────────────\nFund: test-fund';
    const update = makeCallbackUpdate({ data: 'approve:ord-1', messageText: msgText });
    const getUpdates = makeGetUpdatesOnce([update]);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), makeRepo());
    await runUntilPolled(service, getUpdates);

    const editedText = (editMessageText.mock.calls[0][0] as { text: string }).text;
    expect(editedText).toContain('APPROVED ✅');
  });

  it('approve: edited text contains "Approved by human at" byLine', async () => {
    const msgText = '📊 TRADE PROPOSAL\nSome content\n────────────────\nFund: test-fund';
    const update = makeCallbackUpdate({ data: 'approve:ord-1', messageText: msgText });
    const getUpdates = makeGetUpdatesOnce([update]);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), makeRepo());
    await runUntilPolled(service, getUpdates);

    const editedText = (editMessageText.mock.calls[0][0] as { text: string }).text;
    expect(editedText).toContain('Approved by human at');
  });

  it('reject: edited text contains "REJECTED ❌" in header', async () => {
    const msgText = '📊 TRADE PROPOSAL\nSome content\n────────────────\nFund: test-fund';
    const update = makeCallbackUpdate({ data: 'reject:ord-1', messageText: msgText });
    const getUpdates = makeGetUpdatesOnce([update]);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo({ updated: true, order: { id: 'ord-1', symbol: 'TEST', chain: 'base' } });
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    const editedText = (editMessageText.mock.calls[0][0] as { text: string }).text;
    expect(editedText).toContain('REJECTED ❌');
  });

  it('reject: edited text contains "Rejected by human at" byLine', async () => {
    const msgText = '📊 TRADE PROPOSAL\nSome content\n────────────────\nFund: test-fund';
    const update = makeCallbackUpdate({ data: 'reject:ord-1', messageText: msgText });
    const getUpdates = makeGetUpdatesOnce([update]);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo({ updated: true, order: { id: 'ord-1', symbol: 'TEST', chain: 'base' } });
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    const editedText = (editMessageText.mock.calls[0][0] as { text: string }).text;
    expect(editedText).toContain('Rejected by human at');
  });

  it('fallback: text without TRADE PROPOSAL header → byLine appended at end', async () => {
    const msgText = 'Some random message without the header';
    const update = makeCallbackUpdate({ data: 'approve:ord-1', messageText: msgText });
    const getUpdates = makeGetUpdatesOnce([update]);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), makeRepo());
    await runUntilPolled(service, getUpdates);

    const editedText = (editMessageText.mock.calls[0][0] as { text: string }).text;
    expect(editedText).toContain('Some random message');
    expect(editedText).toContain('Approved by human at');
    const lastLine = editedText.split('\n').at(-1);
    expect(lastLine).toContain('Approved by human at');
  });
});

// ---------------------------------------------------------------------------
// Non-callback_query updates skipped
// ---------------------------------------------------------------------------

describe('ApprovalBotService — non-callback_query updates', () => {
  it('skips message-type updates and advances offset without triggering transitionApproval', async () => {
    const updates = [makeMessageUpdate(10), makeCallbackUpdate({ updateId: 11, data: 'approve:ord-1' })];
    const getUpdates = makeGetUpdatesOnce(updates);
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery,
      editMessageText: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo();
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    // Only the callback_query should have triggered transitionApproval
    expect(repo.transitionApproval).toHaveBeenCalledTimes(1);
  });

  it('does not call transitionApproval for pure message updates, offset still advances', async () => {
    const updates = [makeMessageUpdate(5)];
    const system = makeSystem('0');
    const getUpdates = makeGetUpdatesOnce(updates);
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo();
    const service = new ApprovalBotService(makeConfig(), telegram, system, repo);
    await runUntilPolled(service, getUpdates);

    expect(repo.transitionApproval).not.toHaveBeenCalled();
    // Offset advances past the message update (5 + 1 = 6)
    expect(system.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'approval_bot_offset', value: '6' }));
  });
});

// ---------------------------------------------------------------------------
// Error resilience — transitionApproval non-P2025 DB error
// ---------------------------------------------------------------------------

describe('ApprovalBotService — DB error resilience', () => {
  it('answers "Error processing request" on non-P2025 DB error', async () => {
    const update = makeCallbackUpdate({ data: 'approve:ord-1', callbackId: 'cq-err' });
    const getUpdates = makeGetUpdatesOnce([update]);
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      getUpdates,
      answerCallbackQuery,
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = {
      transitionApproval: vi.fn().mockRejectedValue(new Error('UNEXPECTED_DB_ERROR')),
    } as unknown as OrdersRepository;
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Error processing request' }));
  });

  it('does NOT call editMessageText when transitionApproval throws', async () => {
    const update = makeCallbackUpdate({ data: 'approve:ord-1' });
    const getUpdates = makeGetUpdatesOnce([update]);
    const editMessageText = vi.fn();
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = {
      transitionApproval: vi.fn().mockRejectedValue(new Error('CONNECTION_RESET')),
    } as unknown as OrdersRepository;
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    expect(editMessageText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error resilience — editMessageText failure (non-fatal)
// ---------------------------------------------------------------------------

describe('ApprovalBotService — editMessageText failure (non-fatal)', () => {
  it('DB transition is applied even when editMessageText throws (non-fatal)', async () => {
    const update = makeCallbackUpdate({ data: 'approve:ord-1' });
    const getUpdates = makeGetUpdatesOnce([update]);
    const editMessageText = vi.fn().mockRejectedValue(new Error('Bad Request: message too old'));
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const repo = makeRepo();
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), repo);
    await runUntilPolled(service, getUpdates);

    // DB transition should still have succeeded despite edit failure
    expect(repo.transitionApproval).toHaveBeenCalledWith('ord-1', 'pending', 'approved', 'telegram');
  });
});

// ---------------------------------------------------------------------------
// Exponential backoff (fake timers)
// ---------------------------------------------------------------------------

describe('ApprovalBotService — exponential backoff', () => {
  it('backs off 1s → 2s → 4s on consecutive getUpdates rejections', async () => {
    vi.useFakeTimers();

    const failErr = new Error('Telegram network error');
    let callCount = 0;
    const getUpdates = vi.fn().mockImplementation((_p: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount <= 3) return Promise.reject(failErr);
      // After 3 failures, block until abort
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), makeRepo());

    await service.onApplicationBootstrap();

    // First failure: backoff = 1s
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callCount).toBeGreaterThanOrEqual(2);

    // Second failure: backoff = 2s
    await vi.advanceTimersByTimeAsync(2_000);
    expect(callCount).toBeGreaterThanOrEqual(3);

    // Third failure: backoff = 4s
    await vi.advanceTimersByTimeAsync(4_000);
    expect(callCount).toBeGreaterThanOrEqual(4);

    await service.onApplicationShutdown();
    vi.useRealTimers();
  });

  it('caps backoff at 60_000 ms after many failures', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const getUpdates = vi.fn().mockImplementation((_p: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount <= 8) return Promise.reject(new Error('fail'));
      // Block until abort after 8 failures
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });

    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), makeRepo());

    await service.onApplicationBootstrap();

    // Advance through 8 exponential backoff intervals: 1+2+4+8+16+32+60+60 = 183s
    await vi.advanceTimersByTimeAsync(200_000);

    // Should have made 8 failing calls + the waiting call (call 9)
    expect(callCount).toBeGreaterThanOrEqual(9);

    await service.onApplicationShutdown();
    vi.useRealTimers();
  });

  it('resets backoff to 1_000 ms after a successful poll following errors', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const getUpdates = vi.fn().mockImplementation((_p: unknown, signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('fail')); // backoff → 2s
      if (callCount === 2) return Promise.resolve([]); // success → reset to 1s
      if (callCount === 3) return Promise.reject(new Error('fail again')); // backoff = 1s (reset)
      // Block until abort
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
      });
    });

    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), makeRepo());

    await service.onApplicationBootstrap();

    // First failure: sleep 1s → next call
    await vi.advanceTimersByTimeAsync(1_000);
    // call 2 (success) runs immediately
    // call 3 (failure) → backoff 1s again (reset confirmed)
    await vi.advanceTimersByTimeAsync(1_000);

    // Should have made at least 3 calls
    expect(callCount).toBeGreaterThanOrEqual(3);

    await service.onApplicationShutdown();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// AbortSignal cancellation
// ---------------------------------------------------------------------------

describe('ApprovalBotService — AbortSignal cancellation', () => {
  it('onApplicationShutdown() resolves within 5s regardless of loop state', async () => {
    // getUpdates hangs indefinitely — simulates long-poll
    const getUpdates = vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), makeRepo());

    await service.onApplicationBootstrap();
    // Wait for first getUpdates call
    await flushUntil(() => getUpdates.mock.calls.length >= 1);

    const start = Date.now();
    await service.onApplicationShutdown();
    const elapsed = Date.now() - start;

    // onApplicationShutdown should resolve well within 5s
    expect(elapsed).toBeLessThan(5_000);
  });

  it('loop exits cleanly when AbortError bubbles from getUpdates (no retry after abort)', async () => {
    let getUpdatesCalls = 0;
    const getUpdates = vi.fn().mockImplementation((_params: unknown, signal: AbortSignal) => {
      getUpdatesCalls++;
      return new Promise<unknown[]>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
        });
      });
    });
    const telegram = {
      getUpdates,
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as TelegramAdapter;
    const service = new ApprovalBotService(makeConfig(), telegram, makeSystem(), makeRepo());

    await service.onApplicationBootstrap();
    // Wait for first getUpdates call to start
    await flushUntil(() => getUpdatesCalls >= 1);
    await service.onApplicationShutdown();

    // The loop did NOT retry after AbortError
    expect(getUpdatesCalls).toBe(1);
  });
});
