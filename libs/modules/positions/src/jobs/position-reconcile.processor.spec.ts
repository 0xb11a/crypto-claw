/**
 * Unit tests for PositionReconcileProcessor (DoD §A, §E).
 *
 * All external dependencies are mocked at the class boundary.
 * No Redis, no DB, no real RPC calls.
 *
 * Covers:
 *   - PAPER_MODE=true → skips reconcile, writes meta, returns skipped=true.
 *   - No open positions → returns totalPositions=0.
 *   - Drift detected → appendNote called, sendRugWarning called.
 *   - No drift → neither appendNote nor sendRugWarning called.
 *   - Decimals fetch error → counts error, continues next position.
 *   - Balance fetch error → counts error, continues next position.
 *   - Vault address not resolved → counts error, skips position.
 *   - Idempotency: drift marker already present in notes → no duplicate append.
 *   - setMeta is always called (DoD §E).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PositionReconcileProcessor } from './position-reconcile.processor.js';
import type { PositionReconcileJobData } from './position-reconcile.processor.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeJob(): Job<PositionReconcileJobData> {
  return { id: 'test-job-1', data: {} } as unknown as Job<PositionReconcileJobData>;
}

function makePosition(
  overrides: Partial<{
    id: string;
    symbol: string;
    address: string;
    chain: string;
    quantity: number;
    notes: string | null;
  }> = {},
) {
  return {
    id: 'pos-1',
    symbol: 'WETH',
    address: '0xtoken',
    chain: 'base',
    quantity: 100,
    notes: null,
    status: 'open',
    ...overrides,
  };
}

function makeServices(
  overrides: {
    isPaper?: boolean;
    positions?: ReturnType<typeof makePosition>[];
    onchainDecimals?: number | Error;
    onchainBalance?: number | Error;
    vaultAddress?: string | null;
  } = {},
) {
  const {
    isPaper = false,
    positions = [],
    onchainDecimals = 18,
    onchainBalance = 100,
    vaultAddress = '0xsafe',
  } = overrides;

  const positionsService = {
    findOpenAndPartialExit: vi.fn().mockResolvedValue(positions),
    appendNote: vi.fn().mockResolvedValue(undefined),
  };

  const onchainBalanceAdapter = {
    getTokenDecimals:
      onchainDecimals instanceof Error
        ? vi.fn().mockRejectedValue(onchainDecimals)
        : vi.fn().mockResolvedValue(onchainDecimals),
    getTokenBalance:
      onchainBalance instanceof Error
        ? vi.fn().mockRejectedValue(onchainBalance)
        : vi.fn().mockResolvedValue(onchainBalance),
  };

  const notifications = {
    sendRugWarning: vi.fn().mockResolvedValue(undefined),
  };

  const systemService = {
    setMeta: vi.fn().mockResolvedValue({ ok: true }),
  };

  const configService = {
    get: vi.fn((key: string) => {
      if (key === 'PAPER_MODE') return isPaper ? 'true' : 'false';
      // SAFE_ADDRESS_BASE for 'base' chain
      if (key === 'SAFE_ADDRESS_BASE') return vaultAddress;
      return undefined;
    }),
  };

  return { positionsService, onchainBalanceAdapter, notifications, systemService, configService };
}

function makeProcessor(services: ReturnType<typeof makeServices>): PositionReconcileProcessor {
  const p = new PositionReconcileProcessor(
    services.positionsService as unknown as ConstructorParameters<typeof PositionReconcileProcessor>[0],
    services.onchainBalanceAdapter as unknown as ConstructorParameters<typeof PositionReconcileProcessor>[1],
    services.notifications as unknown as ConstructorParameters<typeof PositionReconcileProcessor>[2],
    services.systemService as unknown as ConstructorParameters<typeof PositionReconcileProcessor>[3],
    services.configService as unknown as ConstructorParameters<typeof PositionReconcileProcessor>[4],
  );
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PositionReconcileProcessor', () => {
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
    it('skips reconcile and returns skipped=true', async () => {
      const services = makeServices({ isPaper: true });
      const processor = makeProcessor(services);

      const result = await processor.process(makeJob());

      expect(result.skipped).toBe(true);
      expect(services.positionsService.findOpenAndPartialExit).not.toHaveBeenCalled();
    });

    it('still writes last_position_reconcile_at meta when skipped', async () => {
      const services = makeServices({ isPaper: true });
      const processor = makeProcessor(services);

      await processor.process(makeJob());

      expect(services.systemService.setMeta).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'last_position_reconcile_at' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // No positions
  // -------------------------------------------------------------------------

  describe('no open positions', () => {
    it('returns totalPositions=0 with no drift', async () => {
      const services = makeServices({ positions: [] });
      const processor = makeProcessor(services);

      const result = await processor.process(makeJob());

      expect(result.totalPositions).toBe(0);
      expect(result.driftCount).toBe(0);
      expect(services.notifications.sendRugWarning).not.toHaveBeenCalled();
    });

    it('writes meta even with no positions', async () => {
      const services = makeServices({ positions: [] });
      const processor = makeProcessor(services);

      await processor.process(makeJob());

      expect(services.systemService.setMeta).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'last_position_reconcile_at' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Drift detected
  // -------------------------------------------------------------------------

  describe('drift detected (>1%)', () => {
    it('calls appendNote when drift exceeds threshold', async () => {
      const position = makePosition({ quantity: 100, notes: null });
      // on-chain balance 90 → 10% short drift
      const services = makeServices({ positions: [position], onchainBalance: 90 });
      const processor = makeProcessor(services);

      await processor.process(makeJob());

      expect(services.positionsService.appendNote).toHaveBeenCalledOnce();
      const [, marker] = (services.positionsService.appendNote as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        string,
      ];
      expect(marker).toContain('recon_drift_');
      expect(marker).toContain('direction=short');
    });

    it('calls sendRugWarning when drift is detected', async () => {
      const position = makePosition({ quantity: 100, notes: null });
      const services = makeServices({ positions: [position], onchainBalance: 90 });
      const processor = makeProcessor(services);

      await processor.process(makeJob());

      expect(services.notifications.sendRugWarning).toHaveBeenCalledOnce();
    });

    it('returns driftCount=1 for one drifted position', async () => {
      const position = makePosition({ quantity: 100, notes: null });
      const services = makeServices({ positions: [position], onchainBalance: 90 });
      const processor = makeProcessor(services);

      const result = await processor.process(makeJob());
      expect(result.driftCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // No drift
  // -------------------------------------------------------------------------

  describe('no drift (within 1%)', () => {
    it('does not call appendNote when no drift', async () => {
      const position = makePosition({ quantity: 100, notes: null });
      // 100.5 → 0.5% drift — within threshold
      const services = makeServices({ positions: [position], onchainBalance: 100.5 });
      const processor = makeProcessor(services);

      await processor.process(makeJob());

      expect(services.positionsService.appendNote).not.toHaveBeenCalled();
      expect(services.notifications.sendRugWarning).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('counts error and continues when decimals fetch fails', async () => {
      const position = makePosition();
      const services = makeServices({
        positions: [position],
        onchainDecimals: new Error('RPC timeout'),
      });
      const processor = makeProcessor(services);

      const result = await processor.process(makeJob());

      expect(result.errorCount).toBe(1);
      expect(result.driftCount).toBe(0);
      // setMeta still called
      expect(services.systemService.setMeta).toHaveBeenCalled();
    });

    it('counts error and continues when balance fetch fails', async () => {
      const position = makePosition();
      const services = makeServices({
        positions: [position],
        onchainBalance: new Error('getAccount failed'),
      });
      const processor = makeProcessor(services);

      const result = await processor.process(makeJob());

      expect(result.errorCount).toBe(1);
    });

    it('counts error and skips position when vault address is not resolved', async () => {
      const position = makePosition({ chain: 'base' });
      const services = makeServices({ positions: [position], vaultAddress: null });
      const processor = makeProcessor(services);

      const result = await processor.process(makeJob());

      expect(result.errorCount).toBe(1);
      expect(services.onchainBalanceAdapter.getTokenDecimals).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency guard
  // -------------------------------------------------------------------------

  describe('idempotency (DoD §E)', () => {
    it('does not append duplicate drift marker within same UTC hour', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-14T10:30:00Z'));

      // Notes already have a marker for the current hour
      const existingNotes = '[2026-05-14T10:00:00] recon_drift_10.00pct direction=short db=100 onchain=90';
      const position = makePosition({ quantity: 100, notes: existingNotes });
      // Same drift (90 on-chain → 10% short)
      const services = makeServices({ positions: [position], onchainBalance: 90 });
      const processor = makeProcessor(services);

      // Run process() and advance all fake timers concurrently so the
      // internal 200ms setTimeout resolves.
      await Promise.all([processor.process(makeJob()), vi.runAllTimersAsync()]);

      expect(services.positionsService.appendNote).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // setMeta always called (DoD §E)
  // -------------------------------------------------------------------------

  describe('setMeta always called', () => {
    it('writes last_position_reconcile_at on successful run', async () => {
      const services = makeServices();
      const processor = makeProcessor(services);

      await processor.process(makeJob());

      expect(services.systemService.setMeta).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'last_position_reconcile_at' }),
      );
    });
  });
});
