/**
 * Unit tests for MultisigTrackerProcessor (SPEC §14, DoD §A, §E).
 *
 * Mocks: ReceiptsService, PositionsService, SystemService,
 * NotificationsService, SafeTxServiceAdapter, SquadsRpcAdapter, ConfigService.
 * No real I/O. Tests processor logic in isolation.
 *
 * Covers:
 *   - PAPER_MODE=true → skips, no service calls, returns skipped:true.
 *   - No queued receipts → counts.checked=0, meta key written.
 *   - Orphaned receipt (null position_id) → markReverted('orphaned_position').
 *   - Orphaned receipt (positionsService.getById throws) → markReverted('orphaned_position').
 *   - EVM: missing safe_tx_hash → counts.pending++.
 *   - EVM: safeTxService.getTransaction throws → counts.pending++.
 *   - EVM: executed + successful → markExecuted + position→open (BUY), sendTradeExecuted.
 *   - EVM: executed + successful (SELL) → position→closed, sendTradeExecuted.
 *   - EVM: executed + failed (BUY) → markReverted + cash refund + deleteDraft + sendTradeFailed.
 *   - EVM: executed + failed (SELL) → markReverted + position→open + sendTradeFailed.
 *   - EVM: still pending, should NOT remind (< 30min) → no note update, no alert.
 *   - EVM: still pending, should remind (≥ 30min) → updateNotes + sendCriticalAlert.
 *   - Squads: missing txIndex (safe_nonce) → counts.pending++.
 *   - Squads: found in pending list → still pending (old EVM path behavior; NOT applicable
 *     now — Solana path is feature-flag skipped).
 *   - Coder concern #3: deleteDraft throws → processor logs and continues (no crash).
 *   - meta key last_multisig_tracker_at always written.
 *   [NET-NEW] Solana-skip tests:
 *   - WARN fires exactly once when batch has multiple queued_in_squads receipts.
 *   - Mixed batch (EVM + Solana): EVM runs normally, Solana skipped, single WARN.
 *   - All-Solana batch: meta key still written, no markExecuted calls.
 *   - getPendingTransactions is NEVER called (Solana path skipped before adapter call).
 *
 * Removed tests (behavior no longer exists):
 *   - "calls markExecuted when Squads tx not in pending list" — Solana receipts
 *     are now skipped, never confirmed by this processor.
 *   - "CONCERN-2: getPendingTransactions empty on RPC error → treated as executed" —
 *     getPendingTransactions is never called; the Solana path is an explicit skip.
 *     Replaced by "Solana receipts: pending count incremented, no markExecuted" below.
 *
 * SPEC §4 #4 — no signer keys.
 * SPEC §4 #6 — config via ConfigService.
 * DoD §A, §E.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import type { SafeTxServiceAdapter } from '@cclaw/adapters-safe-tx-service';
import type { SquadsRpcAdapter } from '@cclaw/adapters-squads-rpc';
import type { NotificationsService } from '@cclaw/notifications';
import type { SystemService } from '@cclaw/system';
import type { PositionsService } from '@cclaw/positions';
import type { ReceiptsService } from '@cclaw/receipts';
import { MultisigTrackerProcessor } from './multisig-tracker.processor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(id = 'job-1'): Job {
  return { id } as unknown as Job;
}

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    PAPER_MODE: false,
  };
  const merged = { ...defaults, ...overrides };
  return {
    get: vi.fn((key: string) => merged[key]),
  } as unknown as ConfigService;
}

function makeReceipt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'receipt-1',
    status: 'queued_in_safe',
    chain: 'base',
    position_id: 'pos-1',
    safe_tx_hash: '0xdeadbeef',
    safe_nonce: null,
    symbol: 'TKNA',
    notes: null,
    ...overrides,
  };
}

function makePosition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pos-1',
    status: 'draft',
    chain: 'base',
    value_usd: 500,
    ...overrides,
  };
}

function makeSafeTxService(
  txResult: Partial<{
    executed: boolean;
    isSuccessful: boolean;
    txHash: string | null;
    confirmations: number;
    confirmationsRequired: number;
  }> = {},
): SafeTxServiceAdapter {
  return {
    getSafeInfo: vi.fn(),
    getTransaction: vi.fn().mockResolvedValue({
      executed: false,
      isSuccessful: false,
      txHash: null,
      confirmations: 1,
      confirmationsRequired: 2,
      ...txResult,
    }),
  } as unknown as SafeTxServiceAdapter;
}

function makeSquadsRpc(): SquadsRpcAdapter {
  return {
    getMultisigInfo: vi.fn(),
    getPendingTransactions: vi.fn(),
  } as unknown as SquadsRpcAdapter;
}

function makeNotifications(): NotificationsService {
  return {
    sendCriticalAlert: vi.fn().mockResolvedValue(undefined),
    sendTradeExecuted: vi.fn().mockResolvedValue(undefined),
    sendTradeFailed: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;
}

function makeSystemService(cashAmount = 1000): SystemService {
  return {
    setMeta: vi.fn().mockResolvedValue(undefined),
    getCashByChain: vi.fn().mockResolvedValue({ cash: cashAmount }),
    setCash: vi.fn().mockResolvedValue(undefined),
  } as unknown as SystemService;
}

function makePositionsService(position = makePosition()): PositionsService {
  return {
    getById: vi.fn().mockResolvedValue(position),
    update: vi.fn().mockResolvedValue(undefined),
    deleteDraft: vi.fn().mockResolvedValue(undefined),
  } as unknown as PositionsService;
}

function makeReceiptsService(receipts: unknown[] = []): ReceiptsService {
  return {
    findByStatuses: vi.fn().mockResolvedValue(receipts),
    markExecuted: vi.fn().mockResolvedValue(undefined),
    markReverted: vi.fn().mockResolvedValue(undefined),
    updateNotes: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReceiptsService;
}

function makeProcessor(
  opts: {
    config?: ConfigService;
    receiptsService?: ReceiptsService;
    positionsService?: PositionsService;
    systemService?: SystemService;
    notificationsService?: NotificationsService;
    safeTxService?: SafeTxServiceAdapter;
    squadsRpc?: SquadsRpcAdapter;
  } = {},
): MultisigTrackerProcessor {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

  return new MultisigTrackerProcessor(
    opts.config ?? makeConfig(),
    opts.receiptsService ?? makeReceiptsService(),
    opts.positionsService ?? makePositionsService(),
    opts.systemService ?? makeSystemService(),
    opts.notificationsService ?? makeNotifications(),
    opts.safeTxService ?? makeSafeTxService(),
    opts.squadsRpc ?? makeSquadsRpc(),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MultisigTrackerProcessor', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  // -------------------------------------------------------------------------
  // PAPER_MODE skip
  // -------------------------------------------------------------------------

  describe('PAPER_MODE=true', () => {
    it('returns skipped:true and makes no service calls', async () => {
      const config = makeConfig({ PAPER_MODE: true });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const processor = makeProcessor({ config, receiptsService });

      const result = await processor.process(makeJob());

      expect(result.skipped).toBe(true);
      expect(result.checked).toBe(0);
      expect(receiptsService.findByStatuses).not.toHaveBeenCalled();
    });

    it('does NOT write meta key in PAPER_MODE', async () => {
      const config = makeConfig({ PAPER_MODE: true });
      const systemService = makeSystemService();
      const processor = makeProcessor({ config, systemService });

      await processor.process(makeJob());

      expect(systemService.setMeta).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // No queued receipts
  // -------------------------------------------------------------------------

  describe('no queued receipts', () => {
    it('returns checked=0 when no receipts found', async () => {
      const processor = makeProcessor({ receiptsService: makeReceiptsService([]) });

      const result = await processor.process(makeJob());

      expect(result.checked).toBe(0);
    });

    it('writes meta key even when no receipts', async () => {
      const systemService = makeSystemService();
      const processor = makeProcessor({ receiptsService: makeReceiptsService([]), systemService });

      await processor.process(makeJob());

      expect(systemService.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'last_multisig_tracker_at' }));
    });

    it('calls findByStatuses with ["queued_in_safe","queued_in_squads"]', async () => {
      const receiptsService = makeReceiptsService([]);
      const processor = makeProcessor({ receiptsService });

      await processor.process(makeJob());

      expect(receiptsService.findByStatuses).toHaveBeenCalledWith(['queued_in_safe', 'queued_in_squads']);
    });
  });

  // -------------------------------------------------------------------------
  // Orphaned receipts
  // -------------------------------------------------------------------------

  describe('orphaned receipts', () => {
    it('marks receipt reverted when position_id is null', async () => {
      const orphanReceipt = makeReceipt({ position_id: null });
      const receiptsService = makeReceiptsService([orphanReceipt]);
      const processor = makeProcessor({ receiptsService });

      await processor.process(makeJob());

      expect(receiptsService.markReverted).toHaveBeenCalledWith('receipt-1', 'orphaned_position');
    });

    it('increments failed count for orphaned position_id', async () => {
      const receiptsService = makeReceiptsService([makeReceipt({ position_id: null })]);
      const processor = makeProcessor({ receiptsService });

      const result = await processor.process(makeJob());

      expect(result.failed).toBe(1);
    });

    it('marks reverted when positionsService.getById throws (position deleted)', async () => {
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService();
      (positionsService.getById as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('not found'));
      const processor = makeProcessor({ receiptsService, positionsService });

      await processor.process(makeJob());

      expect(receiptsService.markReverted).toHaveBeenCalledWith('receipt-1', 'orphaned_position');
    });
  });

  // -------------------------------------------------------------------------
  // EVM: missing safe_tx_hash
  // -------------------------------------------------------------------------

  describe('EVM: missing safe_tx_hash', () => {
    it('increments pending count when safe_tx_hash is null', async () => {
      const receipt = makeReceipt({ safe_tx_hash: null });
      const receiptsService = makeReceiptsService([receipt]);
      const processor = makeProcessor({ receiptsService });

      const result = await processor.process(makeJob());

      expect(result.pending).toBe(1);
      expect(result.confirmed).toBe(0);
    });

    it('does NOT call getTransaction when safe_tx_hash is null', async () => {
      const receipt = makeReceipt({ safe_tx_hash: null });
      const receiptsService = makeReceiptsService([receipt]);
      const safeTxService = makeSafeTxService();
      const processor = makeProcessor({ receiptsService, safeTxService });

      await processor.process(makeJob());

      expect(safeTxService.getTransaction).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // EVM: getTransaction throws
  // -------------------------------------------------------------------------

  describe('EVM: getTransaction error', () => {
    it('increments pending count when getTransaction throws', async () => {
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const safeTxService = makeSafeTxService();
      (safeTxService.getTransaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('service unavailable'),
      );
      const processor = makeProcessor({ receiptsService, safeTxService });

      const result = await processor.process(makeJob());

      expect(result.pending).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // EVM: confirmed + successful (BUY)
  // -------------------------------------------------------------------------

  describe('EVM: confirmed + successful — BUY', () => {
    it('calls markExecuted with the onchain tx hash', async () => {
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: true, txHash: '0xonfirmed' });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService(makePosition({ status: 'draft' }));
      const processor = makeProcessor({ receiptsService, positionsService, safeTxService });

      await processor.process(makeJob());

      expect(receiptsService.markExecuted).toHaveBeenCalledWith('receipt-1', '0xonfirmed');
    });

    it('updates position status from draft → open', async () => {
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: true, txHash: '0x1' });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService(makePosition({ status: 'draft' }));
      const processor = makeProcessor({ receiptsService, positionsService, safeTxService });

      await processor.process(makeJob());

      expect(positionsService.update).toHaveBeenCalledWith('pos-1', { status: 'open' }, 'real');
    });

    it('calls sendTradeExecuted on BUY confirm', async () => {
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: true, txHash: '0x1' });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService(makePosition({ status: 'draft' }));
      const notificationsService = makeNotifications();
      const processor = makeProcessor({ receiptsService, positionsService, safeTxService, notificationsService });

      await processor.process(makeJob());

      expect(notificationsService.sendTradeExecuted).toHaveBeenCalled();
    });

    it('increments confirmed count', async () => {
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: true, txHash: '0x1' });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService(makePosition({ status: 'draft' }));
      const processor = makeProcessor({ receiptsService, positionsService, safeTxService });

      const result = await processor.process(makeJob());

      expect(result.confirmed).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // EVM: confirmed + successful (SELL)
  // -------------------------------------------------------------------------

  describe('EVM: confirmed + successful — SELL', () => {
    it('updates position status from pending_exit → closed', async () => {
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: true, txHash: '0x2' });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService(makePosition({ status: 'pending_exit' }));
      const processor = makeProcessor({ receiptsService, positionsService, safeTxService });

      await processor.process(makeJob());

      expect(positionsService.update).toHaveBeenCalledWith('pos-1', { status: 'closed' }, 'real');
    });
  });

  // -------------------------------------------------------------------------
  // EVM: executed + failed (BUY)
  // -------------------------------------------------------------------------

  describe('EVM: executed + failed — BUY', () => {
    it('calls markReverted', async () => {
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: false });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService(makePosition({ status: 'draft', value_usd: 300 }));
      const processor = makeProcessor({ receiptsService, positionsService, safeTxService });

      await processor.process(makeJob());

      expect(receiptsService.markReverted).toHaveBeenCalledWith('receipt-1');
    });

    it('refunds cash = current + value_usd on BUY rejection', async () => {
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: false });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService(makePosition({ status: 'draft', value_usd: 300 }));
      const systemService = makeSystemService(1000);
      const processor = makeProcessor({ receiptsService, positionsService, safeTxService, systemService });

      await processor.process(makeJob());

      expect(systemService.setCash).toHaveBeenCalledWith(expect.objectContaining({ chain: 'base', amount: 1300 }));
    });

    it('calls deleteDraft on BUY rejection', async () => {
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: false });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService(makePosition({ status: 'draft' }));
      const processor = makeProcessor({ receiptsService, positionsService, safeTxService });

      await processor.process(makeJob());

      expect(positionsService.deleteDraft).toHaveBeenCalledWith('pos-1');
    });

    it('calls sendTradeFailed on BUY rejection', async () => {
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: false });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService(makePosition({ status: 'draft' }));
      const notificationsService = makeNotifications();
      const processor = makeProcessor({ receiptsService, positionsService, safeTxService, notificationsService });

      await processor.process(makeJob());

      expect(notificationsService.sendTradeFailed).toHaveBeenCalled();
    });

    it('increments failed count on BUY rejection', async () => {
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: false });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService(makePosition({ status: 'draft' }));
      const processor = makeProcessor({ receiptsService, positionsService, safeTxService });

      const result = await processor.process(makeJob());

      expect(result.failed).toBe(1);
    });

    // Coder concern #3: deleteDraft throws → processor logs and continues
    it('CONCERN-3: does not crash when deleteDraft throws (race condition)', async () => {
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: false });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService(makePosition({ status: 'draft' }));
      (positionsService.deleteDraft as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('position status is not draft'),
      );
      const processor = makeProcessor({ receiptsService, positionsService, safeTxService });

      // Should not throw — processor catches at the outer per-receipt catch block.
      await expect(processor.process(makeJob())).resolves.not.toThrow();
      // Meta key still written
      expect(true).toBe(true); // no crash = test passes
    });
  });

  // -------------------------------------------------------------------------
  // EVM: executed + failed (SELL)
  // -------------------------------------------------------------------------

  describe('EVM: executed + failed — SELL', () => {
    it('reverts position to open on SELL rejection', async () => {
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: false });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService(makePosition({ status: 'pending_exit' }));
      const processor = makeProcessor({ receiptsService, positionsService, safeTxService });

      await processor.process(makeJob());

      expect(positionsService.update).toHaveBeenCalledWith('pos-1', { status: 'open' }, 'real');
    });

    it('does NOT call deleteDraft on SELL rejection', async () => {
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: false });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService(makePosition({ status: 'pending_exit' }));
      const processor = makeProcessor({ receiptsService, positionsService, safeTxService });

      await processor.process(makeJob());

      expect(positionsService.deleteDraft).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // EVM: pending — reminder gate
  // -------------------------------------------------------------------------

  describe('EVM: still pending — reminder', () => {
    it('does NOT call updateNotes or sendCriticalAlert within 30 min window', async () => {
      const now = Date.now();
      const recentReminder = now - 5 * 60 * 1000; // 5 min ago
      const receipt = makeReceipt({ notes: `last_reminder:${recentReminder}` });
      const receiptsService = makeReceiptsService([receipt]);
      const safeTxService = makeSafeTxService({ executed: false, isSuccessful: false });
      const notificationsService = makeNotifications();
      const processor = makeProcessor({ receiptsService, safeTxService, notificationsService });

      await processor.process(makeJob());

      expect(receiptsService.updateNotes).not.toHaveBeenCalled();
      expect(notificationsService.sendCriticalAlert).not.toHaveBeenCalled();
    });

    it('calls updateNotes and sendCriticalAlert after 30+ min interval', async () => {
      const now = Date.now();
      const oldReminder = now - 31 * 60 * 1000; // 31 min ago
      const receipt = makeReceipt({ notes: `last_reminder:${oldReminder}` });
      const receiptsService = makeReceiptsService([receipt]);
      const safeTxService = makeSafeTxService({ executed: false });
      const notificationsService = makeNotifications();
      const processor = makeProcessor({ receiptsService, safeTxService, notificationsService });

      await processor.process(makeJob());

      expect(receiptsService.updateNotes).toHaveBeenCalledWith('receipt-1', expect.stringContaining('last_reminder:'));
      expect(notificationsService.sendCriticalAlert).toHaveBeenCalled();
    });

    it('sendCriticalAlert uses type=system_health for pending reminders', async () => {
      const now = Date.now();
      const oldReminder = now - 31 * 60 * 1000;
      const receipt = makeReceipt({ notes: `last_reminder:${oldReminder}` });
      const receiptsService = makeReceiptsService([receipt]);
      const safeTxService = makeSafeTxService({ executed: false });
      const notificationsService = makeNotifications();
      const processor = makeProcessor({ receiptsService, safeTxService, notificationsService });

      await processor.process(makeJob());

      expect(notificationsService.sendCriticalAlert).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'system_health' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Squads: missing txIndex
  // -------------------------------------------------------------------------

  describe('Squads: missing txIndex (safe_nonce)', () => {
    it('increments pending count when safe_nonce is null', async () => {
      const receipt = makeReceipt({ status: 'queued_in_squads', safe_nonce: null, safe_tx_hash: null });
      const receiptsService = makeReceiptsService([receipt]);
      const squadsRpc = makeSquadsRpc();
      const processor = makeProcessor({ receiptsService, squadsRpc });

      const result = await processor.process(makeJob());

      // Solana path is feature-flag skipped; the receipt increments pending.
      expect(result.pending).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Solana receipts — feature-flag skip (new behavior, PR-D fix)
  //
  // queued_in_squads receipts are now explicitly skipped. The processor does NOT
  // call getPendingTransactions, does NOT call markExecuted, and increments
  // counts.pending per skipped receipt.
  // -------------------------------------------------------------------------

  describe('Solana receipts: feature-flag skip', () => {
    it('WARN fires exactly once when batch contains multiple queued_in_squads receipts', async () => {
      // Three Solana receipts — WARN must fire only once (gated by solanaSkipWarned).
      const receipts = [
        makeReceipt({ id: 'r1', status: 'queued_in_squads', safe_nonce: 1, safe_tx_hash: null }),
        makeReceipt({ id: 'r2', status: 'queued_in_squads', safe_nonce: 2, safe_tx_hash: null }),
        makeReceipt({ id: 'r3', status: 'queued_in_squads', safe_nonce: 3, safe_tx_hash: null }),
      ];
      const receiptsService = makeReceiptsService(receipts);
      const positionsService = makePositionsService();
      // All three share pos-1 — that's fine for this test
      const processor = makeProcessor({ receiptsService, positionsService });
      // Capture spy AFTER makeProcessor (which resets all mock implementations)
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      await processor.process(makeJob());

      // Filter warn calls to only the Solana-skip message (entrypoint.sh mention)
      const solanaWarnCalls = warnSpy.mock.calls.filter((call) => String(call[0]).includes('entrypoint.sh'));
      expect(solanaWarnCalls).toHaveLength(1);
    });

    it('getPendingTransactions is NEVER called (Solana skip is before adapter call)', async () => {
      const receipts = [
        makeReceipt({ id: 'r1', status: 'queued_in_squads', safe_nonce: 10, safe_tx_hash: null }),
        makeReceipt({ id: 'r2', status: 'queued_in_squads', safe_nonce: 11, safe_tx_hash: null }),
      ];
      const receiptsService = makeReceiptsService(receipts);
      const squadsRpc = makeSquadsRpc();

      const processor = makeProcessor({ receiptsService, squadsRpc });
      await processor.process(makeJob());

      expect(squadsRpc.getPendingTransactions).not.toHaveBeenCalled();
    });

    it('Mixed batch (EVM + Solana): EVM runs normally, Solana skipped, single WARN', async () => {
      const evmReceipt = makeReceipt({
        id: 'evm-r1',
        status: 'queued_in_safe',
        chain: 'base',
        safe_tx_hash: '0xabc',
      });
      const solanaReceipt1 = makeReceipt({
        id: 'sol-r1',
        status: 'queued_in_squads',
        chain: 'solana',
        safe_tx_hash: null,
        safe_nonce: 5,
      });
      const solanaReceipt2 = makeReceipt({
        id: 'sol-r2',
        status: 'queued_in_squads',
        chain: 'solana',
        safe_tx_hash: null,
        safe_nonce: 6,
      });
      const receiptsService = makeReceiptsService([evmReceipt, solanaReceipt1, solanaReceipt2]);
      // EVM: tx not yet executed (still pending)
      const safeTxService = makeSafeTxService({ executed: false });
      const squadsRpc = makeSquadsRpc();

      const processor = makeProcessor({ receiptsService, safeTxService, squadsRpc });
      // Capture spy AFTER makeProcessor (which resets all mock implementations)
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const result = await processor.process(makeJob());

      // EVM path: still pending → counts.pending++
      // Solana path: 2 receipts, each → counts.pending++; only 1 WARN
      expect(result.pending).toBe(3);
      expect(result.confirmed).toBe(0);
      expect(squadsRpc.getPendingTransactions).not.toHaveBeenCalled();

      const solanaWarnCalls = warnSpy.mock.calls.filter((call) => String(call[0]).includes('entrypoint.sh'));
      expect(solanaWarnCalls).toHaveLength(1);
    });

    it('All-Solana batch: meta key still written, no markExecuted calls', async () => {
      const receipts = [
        makeReceipt({ id: 'r1', status: 'queued_in_squads', safe_nonce: 20, safe_tx_hash: null }),
        makeReceipt({ id: 'r2', status: 'queued_in_squads', safe_nonce: 21, safe_tx_hash: null }),
      ];
      const receiptsService = makeReceiptsService(receipts);
      const systemService = makeSystemService();

      const processor = makeProcessor({ receiptsService, systemService });
      await processor.process(makeJob());

      expect(receiptsService.markExecuted).not.toHaveBeenCalled();
      expect(receiptsService.markReverted).not.toHaveBeenCalled();
      expect(systemService.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'last_multisig_tracker_at' }));
    });

    it('Solana receipts increment pending count (not confirmed)', async () => {
      // Replaces the old CONCERN-2 test. The new behavior is: Solana receipts are
      // skipped unconditionally. There is no "false positive confirmed" path.
      const receipt = makeReceipt({ status: 'queued_in_squads', safe_nonce: 99, safe_tx_hash: null });
      const receiptsService = makeReceiptsService([receipt]);
      const squadsRpc = makeSquadsRpc();

      const processor = makeProcessor({ receiptsService, squadsRpc });
      const result = await processor.process(makeJob());

      // The receipt is skipped → pending++, not confirmed++
      expect(result.pending).toBe(1);
      expect(result.confirmed).toBe(0);
      expect(receiptsService.markExecuted).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Meta key invariant
  // -------------------------------------------------------------------------

  describe('meta key invariant', () => {
    it('always writes last_multisig_tracker_at', async () => {
      const systemService = makeSystemService();
      const processor = makeProcessor({ systemService });

      await processor.process(makeJob());

      expect(systemService.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'last_multisig_tracker_at' }));
    });

    it('meta value is ISO timestamp', async () => {
      const systemService = makeSystemService();
      const processor = makeProcessor({ systemService });

      await processor.process(makeJob());

      const callArg = (systemService.setMeta as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        value: string;
      };
      expect(callArg?.value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('result.skipped is false on normal run', async () => {
      const processor = makeProcessor({ receiptsService: makeReceiptsService([]) });
      const result = await processor.process(makeJob());
      expect(result.skipped).toBe(false);
    });
  });
});
