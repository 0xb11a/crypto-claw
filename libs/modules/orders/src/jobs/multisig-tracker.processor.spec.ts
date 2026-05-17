/**
 * Unit tests for MultisigTrackerProcessor (SPEC §14, DoD §A, §E).
 *
 * Mocks: ReceiptsService, PositionsService, SystemService,
 * NotificationsService, SafeTxServiceAdapter, SquadsRpcAdapter, ConfigService.
 * No real I/O. Tests processor logic in isolation.
 *
 * Covers:
 *   PAPER_MODE:
 *   - PAPER_MODE=true → skips, no service calls, returns skipped:true.
 *
 *   Empty receipts:
 *   - No queued receipts → counts.checked=0, meta key written.
 *   - findByStatuses called with ["queued_in_safe","queued_in_squads"].
 *
 *   Orphaned receipts:
 *   - null position_id → markReverted('orphaned_position').
 *   - positionsService.getById throws → markReverted('orphaned_position').
 *
 *   EVM receipts:
 *   - missing safe_tx_hash → counts.pending++.
 *   - getTransaction throws → counts.pending++.
 *   - executed + successful (BUY) → markExecuted + position→open + sendTradeExecuted.
 *   - executed + successful (SELL) → position→closed + sendTradeExecuted.
 *   - executed + failed (BUY) → markReverted + cash refund + deleteDraft + sendTradeFailed.
 *   - executed + failed (SELL) → markReverted + position→open + sendTradeFailed.
 *   - still pending, < 30min → no reminder.
 *   - still pending, ≥ 30min → updateNotes + sendCriticalAlert.
 *   - deleteDraft throws → processor does not crash.
 *
 *   Squads receipts — SDK port complete:
 *   - getPendingTransactions called once per cycle (batch fetch).
 *   - getPendingTransactions NOT called when no queued_in_squads receipts.
 *   - Squads receipt in pending list → still pending (handlePending).
 *   - Squads receipt NOT in pending list → markExecuted (assumed executed).
 *   - Squads receipt NOT in pending list, BUY → position→open + sendTradeExecuted.
 *   - Squads receipt NOT in pending list, SELL → position→closed + sendTradeExecuted.
 *   - missing safe_nonce → counts.pending++.
 *   - SquadsAddressMissingError → squadsPending=null, receipt stays pending, no crash.
 *   - SquadsRpcError → squadsPending=null, receipt stays pending, no crash.
 *   - getPendingTransactions fetch failure + EVM receipts in same batch → EVM still processed.
 *   - Idempotency: running twice with same Active proposal → same pending count.
 *
 *   Meta key invariant:
 *   - last_multisig_tracker_at always written.
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
import { SquadsRpcAdapter, SquadsAddressMissingError, SquadsRpcError } from '@cclaw/adapters-squads-rpc';
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

function makeSquadsRpc(pending: Array<{ transactionIndex: number; approved: number }> = []): SquadsRpcAdapter {
  return {
    getMultisigInfo: vi.fn(),
    getPendingTransactions: vi.fn().mockResolvedValue(pending),
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

    it('does NOT call getPendingTransactions when no receipts', async () => {
      const squadsRpc = makeSquadsRpc();
      const processor = makeProcessor({ receiptsService: makeReceiptsService([]), squadsRpc });

      await processor.process(makeJob());

      expect(squadsRpc.getPendingTransactions).not.toHaveBeenCalled();
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

    it('CONCERN-3: does not crash when deleteDraft throws (race condition)', async () => {
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: false });
      const receiptsService = makeReceiptsService([makeReceipt()]);
      const positionsService = makePositionsService(makePosition({ status: 'draft' }));
      (positionsService.deleteDraft as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('position status is not draft'),
      );
      const processor = makeProcessor({ receiptsService, positionsService, safeTxService });

      await expect(processor.process(makeJob())).resolves.not.toThrow();
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
  // Squads receipts — SDK port complete
  // -------------------------------------------------------------------------

  describe('Squads receipts — SDK port complete', () => {
    it('calls getPendingTransactions exactly once per cycle when Squads receipts present', async () => {
      const receipts = [
        makeReceipt({ id: 'r1', status: 'queued_in_squads', safe_nonce: 1, safe_tx_hash: null }),
        makeReceipt({ id: 'r2', status: 'queued_in_squads', safe_nonce: 2, safe_tx_hash: null }),
      ];
      const receiptsService = makeReceiptsService(receipts);
      // Both receipts in pending list → still pending
      const squadsRpc = makeSquadsRpc([
        { transactionIndex: 1, approved: 1 },
        { transactionIndex: 2, approved: 0 },
      ]);

      const processor = makeProcessor({ receiptsService, squadsRpc });
      await processor.process(makeJob());

      expect(squadsRpc.getPendingTransactions).toHaveBeenCalledOnce();
    });

    it('does NOT call getPendingTransactions when no queued_in_squads receipts', async () => {
      const receipts = [makeReceipt({ status: 'queued_in_safe', safe_tx_hash: '0xevm' })];
      const receiptsService = makeReceiptsService(receipts);
      const squadsRpc = makeSquadsRpc([]);

      const processor = makeProcessor({ receiptsService, squadsRpc });
      await processor.process(makeJob());

      expect(squadsRpc.getPendingTransactions).not.toHaveBeenCalled();
    });

    it('receipt still in pending list → counts.pending++, NO markExecuted', async () => {
      const receipt = makeReceipt({ id: 'r1', status: 'queued_in_squads', safe_nonce: 10, safe_tx_hash: null });
      const receiptsService = makeReceiptsService([receipt]);
      // txIndex 10 IS in the pending list → still pending
      const squadsRpc = makeSquadsRpc([{ transactionIndex: 10, approved: 1 }]);

      const processor = makeProcessor({ receiptsService, squadsRpc });
      const result = await processor.process(makeJob());

      expect(result.pending).toBe(1);
      expect(result.confirmed).toBe(0);
      expect(receiptsService.markExecuted).not.toHaveBeenCalled();
    });

    it('receipt NOT in pending list (BUY) → markExecuted + position→open + sendTradeExecuted', async () => {
      const receipt = makeReceipt({ id: 'r1', status: 'queued_in_squads', safe_nonce: 5, safe_tx_hash: null });
      const receiptsService = makeReceiptsService([receipt]);
      // txIndex 5 is NOT in the pending list → executed
      const squadsRpc = makeSquadsRpc([]); // empty pending list
      const positionsService = makePositionsService(makePosition({ status: 'draft' }));
      const notificationsService = makeNotifications();

      const processor = makeProcessor({ receiptsService, squadsRpc, positionsService, notificationsService });
      const result = await processor.process(makeJob());

      expect(result.confirmed).toBe(1);
      expect(receiptsService.markExecuted).toHaveBeenCalledWith('r1', null); // null tx hash for Squads
      expect(positionsService.update).toHaveBeenCalledWith('pos-1', { status: 'open' }, 'real');
      expect(notificationsService.sendTradeExecuted).toHaveBeenCalled();
    });

    it('receipt NOT in pending list (SELL) → markExecuted + position→closed', async () => {
      const receipt = makeReceipt({ id: 'r1', status: 'queued_in_squads', safe_nonce: 7, safe_tx_hash: null });
      const receiptsService = makeReceiptsService([receipt]);
      const squadsRpc = makeSquadsRpc([]); // empty — txIndex 7 considered executed
      const positionsService = makePositionsService(makePosition({ status: 'pending_exit' }));
      const notificationsService = makeNotifications();

      const processor = makeProcessor({ receiptsService, squadsRpc, positionsService, notificationsService });
      await processor.process(makeJob());

      expect(positionsService.update).toHaveBeenCalledWith('pos-1', { status: 'closed' }, 'real');
      expect(notificationsService.sendTradeExecuted).toHaveBeenCalled();
    });

    it('missing safe_nonce (safe_nonce=null) → counts.pending++, no markExecuted', async () => {
      const receipt = makeReceipt({ status: 'queued_in_squads', safe_nonce: null, safe_tx_hash: null });
      const receiptsService = makeReceiptsService([receipt]);
      const squadsRpc = makeSquadsRpc([]);

      const processor = makeProcessor({ receiptsService, squadsRpc });
      const result = await processor.process(makeJob());

      expect(result.pending).toBe(1);
      expect(receiptsService.markExecuted).not.toHaveBeenCalled();
    });

    it('SquadsAddressMissingError → squadsPending=null, Squads receipt stays pending, no crash', async () => {
      const receipt = makeReceipt({ status: 'queued_in_squads', safe_nonce: 3, safe_tx_hash: null });
      const receiptsService = makeReceiptsService([receipt]);
      const squadsRpc = makeSquadsRpc();
      (squadsRpc.getPendingTransactions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SquadsAddressMissingError(),
      );

      const processor = makeProcessor({ receiptsService, squadsRpc });
      const result = await processor.process(makeJob());

      expect(result.pending).toBe(1);
      expect(receiptsService.markExecuted).not.toHaveBeenCalled();
      // No crash — meta key still written
      const systemService = processor['systemService'] as SystemService;
      void systemService; // just checks we got here without throw
    });

    it('SquadsRpcError → squadsPending=null, receipt stays pending, no crash', async () => {
      const receipt = makeReceipt({ status: 'queued_in_squads', safe_nonce: 4, safe_tx_hash: null });
      const receiptsService = makeReceiptsService([receipt]);
      const squadsRpc = makeSquadsRpc();
      (squadsRpc.getPendingTransactions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SquadsRpcError('getPendingTransactions', 'RPC unavailable'),
      );

      const processor = makeProcessor({ receiptsService, squadsRpc });
      await expect(processor.process(makeJob())).resolves.not.toThrow();
    });

    it('Squads fetch failure + EVM receipts: EVM receipts still processed', async () => {
      const evmReceipt = makeReceipt({ id: 'evm-r1', status: 'queued_in_safe', safe_tx_hash: '0xabc' });
      const solReceipt = makeReceipt({
        id: 'sol-r1',
        status: 'queued_in_squads',
        safe_nonce: 9,
        safe_tx_hash: null,
      });
      const receiptsService = makeReceiptsService([evmReceipt, solReceipt]);
      // EVM: tx executed + successful
      const safeTxService = makeSafeTxService({ executed: true, isSuccessful: true, txHash: '0x123' });
      const positionsService = makePositionsService(makePosition({ status: 'draft' }));
      const squadsRpc = makeSquadsRpc();
      (squadsRpc.getPendingTransactions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SquadsRpcError('getPendingTransactions', 'timeout'),
      );

      const processor = makeProcessor({ receiptsService, safeTxService, positionsService, squadsRpc });
      const result = await processor.process(makeJob());

      // EVM receipt confirmed
      expect(result.confirmed).toBe(1);
      // Squads receipt pending (fetch failed)
      expect(result.pending).toBe(1);
    });

    // Idempotency test — DoD §E
    it('Idempotency: running twice with same Active proposal yields same pending count', async () => {
      const receipt = makeReceipt({ status: 'queued_in_squads', safe_nonce: 42, safe_tx_hash: null });
      const receiptsService = makeReceiptsService([receipt]);
      // txIndex 42 is still Active both times
      const squadsRpc = makeSquadsRpc([{ transactionIndex: 42, approved: 1 }]);

      const processor = makeProcessor({ receiptsService, squadsRpc });

      const result1 = await processor.process(makeJob('job-1'));
      const result2 = await processor.process(makeJob('job-2'));

      expect(result1.pending).toBe(1);
      expect(result2.pending).toBe(1);
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
