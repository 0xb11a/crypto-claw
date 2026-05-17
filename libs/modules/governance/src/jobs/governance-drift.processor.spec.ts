/**
 * Unit tests for GovernanceDriftProcessor (SPEC §14, DoD §A, §E).
 *
 * Mocks: SafeTxServiceAdapter, SquadsRpcAdapter, NotificationsService, SystemService,
 * ConfigService. Tests the processor logic in isolation with no real I/O.
 *
 * Covers:
 *   - PAPER_MODE=true → skips immediately, returns skipped:true, no adapter calls.
 *   - No active chains → chainsChecked=0, no adapter calls.
 *   - ACTIVE_CHAINS contains unknown chain → filtered out gracefully.
 *   - EVM chain with no expected config → skipped, no alert, meta key written.
 *   - EVM chain with no Safe address → skipped, no alert.
 *   - EVM chain with drift detected → sendCriticalAlert called once with rug_warning.
 *   - EVM chain no drift → sendCriticalAlert NOT called.
 *   - Solana chain (ACTIVE_CHAINS=solana):
 *       - getMultisigInfo IS called (SDK port complete).
 *       - With no expected config → chainsChecked=0, no alert.
 *       - With expected config + no drift → chainsChecked=1, no alert.
 *       - With expected config + member drift → sendCriticalAlert called.
 *       - SquadsAddressMissingError → swallowed (debug log), loop continues.
 *       - SquadsRpcError → swallowed (warn log), loop continues.
 *   - SafeTxServiceChainError → swallowed, loop continues.
 *   - Generic adapter error → logged + continues.
 *   - meta key `last_governance_drift_at` always written (even with errors).
 *   - GovernanceDriftResult shape is correct.
 *
 * SPEC §4 #4 — no signer-key env vars.
 * SPEC §4 #6 — config via ConfigService.
 * DoD §A — tests fail before, pass after.
 * DoD §E — meta key always written; idempotency guaranteed (timestamp-only mutation).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { SafeTxServiceAdapter, SafeTxServiceChainError } from '@cclaw/adapters-safe-tx-service';
import { SquadsRpcAdapter, SquadsAddressMissingError, SquadsRpcError } from '@cclaw/adapters-squads-rpc';
import type { NotificationsService } from '@cclaw/notifications';
import type { SystemService } from '@cclaw/system';
import { GovernanceDriftProcessor } from './governance-drift.processor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function makeJob(id = 'job-1'): Job {
  return { id } as unknown as Job;
}

function makeConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    PAPER_MODE: false,
    ACTIVE_CHAINS: 'base',
    EXPECTED_SAFE_OWNERS_BASE: '0xownerA,0xownerB',
    EXPECTED_SAFE_THRESHOLD_BASE: '2',
    EXPECTED_SAFE_MODULES_BASE: undefined,
    SAFE_ADDRESS_BASE: '0xSafeAddress',
    EXPECTED_SQUADS_MEMBERS: undefined,
    EXPECTED_SQUADS_THRESHOLD: undefined,
  };
  const merged = { ...defaults, ...overrides };
  return {
    get: vi.fn((key: string) => merged[key]),
  } as unknown as ConfigService;
}

function makeSafeTxService(
  safeInfo: DeepPartial<Awaited<ReturnType<SafeTxServiceAdapter['getSafeInfo']>>> = {},
): SafeTxServiceAdapter {
  return {
    getSafeInfo: vi.fn().mockResolvedValue({
      owners: ['0xOwnerA', '0xOwnerB'],
      threshold: 2,
      modules: [],
      nonce: 5,
      ...safeInfo,
    }),
    getTransaction: vi.fn(),
  } as unknown as SafeTxServiceAdapter;
}

function makeSquadsRpc(
  multisigInfo: { members: string[]; threshold: number } = { members: ['PubKeyAlpha', 'PubKeyBeta'], threshold: 2 },
): SquadsRpcAdapter {
  return {
    getMultisigInfo: vi.fn().mockResolvedValue(multisigInfo),
    getPendingTransactions: vi.fn().mockResolvedValue([]),
  } as unknown as SquadsRpcAdapter;
}

function makeNotificationsService(): NotificationsService {
  return {
    sendCriticalAlert: vi.fn().mockResolvedValue(undefined),
    sendTradeExecuted: vi.fn().mockResolvedValue(undefined),
    sendTradeFailed: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;
}

function makeSystemService(): SystemService {
  return {
    setMeta: vi.fn().mockResolvedValue(undefined),
    getCashByChain: vi.fn(),
    setCash: vi.fn(),
  } as unknown as SystemService;
}

function makeProcessor(
  configService: ConfigService,
  safeTxService: SafeTxServiceAdapter,
  squadsRpc: SquadsRpcAdapter,
  notificationsService: NotificationsService,
  systemService: SystemService,
): GovernanceDriftProcessor {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  return new GovernanceDriftProcessor(configService, safeTxService, squadsRpc, notificationsService, systemService);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GovernanceDriftProcessor', () => {
  let safeTxService: SafeTxServiceAdapter;
  let squadsRpc: SquadsRpcAdapter;
  let notificationsService: NotificationsService;
  let systemService: SystemService;

  beforeEach(() => {
    safeTxService = makeSafeTxService();
    squadsRpc = makeSquadsRpc();
    notificationsService = makeNotificationsService();
    systemService = makeSystemService();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  // -------------------------------------------------------------------------
  // PAPER_MODE skip
  // -------------------------------------------------------------------------

  describe('PAPER_MODE=true', () => {
    it('returns skipped:true and makes no adapter calls', async () => {
      const config = makeConfigService({ PAPER_MODE: true });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      const result = await processor.process(makeJob());

      expect(result.skipped).toBe(true);
      expect(result.chainsChecked).toBe(0);
      expect(result.driftAlerts).toBe(0);
      expect(safeTxService.getSafeInfo).not.toHaveBeenCalled();
      expect(squadsRpc.getMultisigInfo).not.toHaveBeenCalled();
    });

    it('does NOT write meta key when skipping in PAPER_MODE', async () => {
      const config = makeConfigService({ PAPER_MODE: true });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(systemService.setMeta).not.toHaveBeenCalled();
    });

    it('does NOT call sendCriticalAlert in PAPER_MODE', async () => {
      const config = makeConfigService({ PAPER_MODE: true });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(notificationsService.sendCriticalAlert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // No active chains
  // -------------------------------------------------------------------------

  describe('ACTIVE_CHAINS empty / invalid', () => {
    it('returns chainsChecked=0 when ACTIVE_CHAINS is empty string', async () => {
      const config = makeConfigService({ ACTIVE_CHAINS: '' });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      const result = await processor.process(makeJob());

      expect(result.chainsChecked).toBe(0);
      expect(result.skipped).toBe(false);
    });

    it('writes meta key even when no chains active', async () => {
      const config = makeConfigService({ ACTIVE_CHAINS: '' });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(systemService.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'last_governance_drift_at' }));
    });

    it('filters out unknown chain names', async () => {
      const config = makeConfigService({ ACTIVE_CHAINS: 'unknown-chain-xyz' });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      const result = await processor.process(makeJob());

      expect(result.chainsChecked).toBe(0);
      expect(safeTxService.getSafeInfo).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // EVM chain — no expected config → skip chain
  // -------------------------------------------------------------------------

  describe('EVM chain — no expected config', () => {
    it('skips chain and does not call getSafeInfo when no expected config', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'base',
        EXPECTED_SAFE_OWNERS_BASE: undefined,
        EXPECTED_SAFE_THRESHOLD_BASE: undefined,
        EXPECTED_SAFE_MODULES_BASE: undefined,
      });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(safeTxService.getSafeInfo).not.toHaveBeenCalled();
    });

    it('does not call sendCriticalAlert when no expected config', async () => {
      const config = makeConfigService({
        EXPECTED_SAFE_OWNERS_BASE: undefined,
        EXPECTED_SAFE_THRESHOLD_BASE: undefined,
      });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(notificationsService.sendCriticalAlert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // EVM chain — no Safe address → skip
  // -------------------------------------------------------------------------

  describe('EVM chain — no Safe address configured', () => {
    it('skips chain when SAFE_ADDRESS_BASE is absent', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'base',
        EXPECTED_SAFE_OWNERS_BASE: '0xownerA',
        SAFE_ADDRESS_BASE: undefined,
      });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(safeTxService.getSafeInfo).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // EVM chain — no drift
  // -------------------------------------------------------------------------

  describe('EVM chain — no drift detected', () => {
    it('does not call sendCriticalAlert when observed matches expected', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'base',
        EXPECTED_SAFE_OWNERS_BASE: '0xownerA,0xownerB',
        EXPECTED_SAFE_THRESHOLD_BASE: '2',
        SAFE_ADDRESS_BASE: '0xSafe',
      });
      safeTxService = makeSafeTxService({
        owners: ['0xOwnerA', '0xOwnerB'],
        threshold: 2,
        modules: [],
      });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(notificationsService.sendCriticalAlert).not.toHaveBeenCalled();
    });

    it('increments chainsChecked for no-drift chain', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'base',
        EXPECTED_SAFE_OWNERS_BASE: '0xownerA',
        EXPECTED_SAFE_THRESHOLD_BASE: '1',
        SAFE_ADDRESS_BASE: '0xSafe',
      });
      safeTxService = makeSafeTxService({ owners: ['0xOwnerA'], threshold: 1 });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      const result = await processor.process(makeJob());

      expect(result.chainsChecked).toBe(1);
      expect(result.driftAlerts).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // EVM chain — drift detected
  // -------------------------------------------------------------------------

  describe('EVM chain — drift detected', () => {
    it('calls sendCriticalAlert once when owner drift detected', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'base',
        EXPECTED_SAFE_OWNERS_BASE: '0xownerA,0xownerB',
        EXPECTED_SAFE_THRESHOLD_BASE: '2',
        SAFE_ADDRESS_BASE: '0xSafe',
      });
      safeTxService = makeSafeTxService({
        owners: ['0xOwnerA', '0xOwnerB', '0xAttacker'], // unexpected owner
        threshold: 2,
      });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(notificationsService.sendCriticalAlert).toHaveBeenCalledOnce();
    });

    it('sends alert with type=rug_warning and agent=governance', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'base',
        EXPECTED_SAFE_OWNERS_BASE: '0xownerA',
        EXPECTED_SAFE_THRESHOLD_BASE: '1',
        SAFE_ADDRESS_BASE: '0xSafe',
      });
      safeTxService = makeSafeTxService({ owners: [], threshold: 1 }); // owner removed
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(notificationsService.sendCriticalAlert).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'rug_warning', agent: 'governance' }),
      );
    });

    it('includes drift detail in alert message', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'base',
        EXPECTED_SAFE_OWNERS_BASE: '0xownerA',
        EXPECTED_SAFE_THRESHOLD_BASE: '1',
        SAFE_ADDRESS_BASE: '0xSafe',
      });
      safeTxService = makeSafeTxService({
        owners: ['0xOwnerA', '0xUnexpected'],
        threshold: 1,
      });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      const callArg = (notificationsService.sendCriticalAlert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        message: string;
      };
      expect(callArg?.message).toContain('owner_added');
    });

    it('sets driftAlerts count in result', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'base',
        EXPECTED_SAFE_OWNERS_BASE: '0xownerA',
        EXPECTED_SAFE_THRESHOLD_BASE: '2',
        SAFE_ADDRESS_BASE: '0xSafe',
      });
      safeTxService = makeSafeTxService({
        owners: ['0xOwnerA', '0xAttacker'],
        threshold: 1, // also threshold_lowered
      });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      const result = await processor.process(makeJob());

      expect(result.driftAlerts).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Solana chain — SDK port complete
  //
  // The Solana branch now calls SquadsRpcAdapter.getMultisigInfo() for real.
  // entrypoint.sh:run_governance_drift_loop is disabled (commented out).
  // -------------------------------------------------------------------------

  describe('Solana chain — SDK port complete', () => {
    it('calls getMultisigInfo when Solana is in ACTIVE_CHAINS and expected config is set', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'solana',
        EXPECTED_SQUADS_MEMBERS: 'PubKeyAlpha,PubKeyBeta',
        EXPECTED_SQUADS_THRESHOLD: '2',
      });
      squadsRpc = makeSquadsRpc({ members: ['PubKeyAlpha', 'PubKeyBeta'], threshold: 2 });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(squadsRpc.getMultisigInfo).toHaveBeenCalledOnce();
    });

    it('does NOT call getMultisigInfo when no expected Squads config is set', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'solana',
        EXPECTED_SQUADS_MEMBERS: undefined,
        EXPECTED_SQUADS_THRESHOLD: undefined,
      });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(squadsRpc.getMultisigInfo).not.toHaveBeenCalled();
    });

    it('chainsChecked=0 when no expected Squads config', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'solana',
        EXPECTED_SQUADS_MEMBERS: undefined,
        EXPECTED_SQUADS_THRESHOLD: undefined,
      });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      const result = await processor.process(makeJob());

      expect(result.chainsChecked).toBe(0);
    });

    it('chainsChecked=1 and no alert when observed members match expected', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'solana',
        EXPECTED_SQUADS_MEMBERS: 'PubKeyAlpha,PubKeyBeta',
        EXPECTED_SQUADS_THRESHOLD: '2',
      });
      squadsRpc = makeSquadsRpc({ members: ['PubKeyAlpha', 'PubKeyBeta'], threshold: 2 });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      const result = await processor.process(makeJob());

      expect(result.chainsChecked).toBe(1);
      expect(result.driftAlerts).toBe(0);
      expect(notificationsService.sendCriticalAlert).not.toHaveBeenCalled();
    });

    it('sends rug_warning alert when Squads member drift detected', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'solana',
        EXPECTED_SQUADS_MEMBERS: 'PubKeyAlpha,PubKeyBeta',
        EXPECTED_SQUADS_THRESHOLD: '2',
      });
      squadsRpc = makeSquadsRpc({
        members: ['PubKeyAlpha', 'PubKeyBeta', 'PubKeyAttacker'], // unexpected member
        threshold: 2,
      });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(notificationsService.sendCriticalAlert).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'rug_warning', agent: 'governance' }),
      );
    });

    it('sends rug_warning alert when Squads threshold lowered', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'solana',
        EXPECTED_SQUADS_MEMBERS: 'PubKeyAlpha,PubKeyBeta',
        EXPECTED_SQUADS_THRESHOLD: '2',
      });
      squadsRpc = makeSquadsRpc({ members: ['PubKeyAlpha', 'PubKeyBeta'], threshold: 1 });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(notificationsService.sendCriticalAlert).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'rug_warning' }),
      );
    });

    it('alert message contains chainName "solana" and drift detail', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'solana',
        EXPECTED_SQUADS_MEMBERS: 'PubKeyAlpha',
        EXPECTED_SQUADS_THRESHOLD: '1',
      });
      squadsRpc = makeSquadsRpc({ members: ['PubKeyAlpha', 'PubKeyEvil'], threshold: 1 });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      const callArg = (notificationsService.sendCriticalAlert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        message: string;
      };
      expect(callArg?.message).toContain('solana');
      expect(callArg?.message).toContain('member_added');
    });

    it('swallows SquadsAddressMissingError and continues (debug log only)', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'solana',
        EXPECTED_SQUADS_MEMBERS: 'PubKeyAlpha',
        EXPECTED_SQUADS_THRESHOLD: '1',
      });
      squadsRpc = makeSquadsRpc();
      (squadsRpc.getMultisigInfo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new SquadsAddressMissingError());
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await expect(processor.process(makeJob())).resolves.not.toThrow();
      expect(notificationsService.sendCriticalAlert).not.toHaveBeenCalled();
      expect(systemService.setMeta).toHaveBeenCalled(); // meta still written
    });

    it('swallows SquadsRpcError and continues (warn log)', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'solana',
        EXPECTED_SQUADS_MEMBERS: 'PubKeyAlpha',
        EXPECTED_SQUADS_THRESHOLD: '1',
      });
      squadsRpc = makeSquadsRpc();
      (squadsRpc.getMultisigInfo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SquadsRpcError('getMultisigInfo', 'RPC unreachable'),
      );
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await expect(processor.process(makeJob())).resolves.not.toThrow();
      expect(notificationsService.sendCriticalAlert).not.toHaveBeenCalled();
    });

    it('last_governance_drift_at written even when getMultisigInfo throws', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'solana',
        EXPECTED_SQUADS_MEMBERS: 'PubKeyAlpha',
        EXPECTED_SQUADS_THRESHOLD: '1',
      });
      squadsRpc = makeSquadsRpc();
      (squadsRpc.getMultisigInfo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SquadsRpcError('getMultisigInfo', 'network error'),
      );
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(systemService.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'last_governance_drift_at' }));
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('swallows SafeTxServiceChainError and continues', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'base',
        EXPECTED_SAFE_OWNERS_BASE: '0xownerA',
        EXPECTED_SAFE_THRESHOLD_BASE: '1',
        SAFE_ADDRESS_BASE: '0xSafe',
      });
      (safeTxService.getSafeInfo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SafeTxServiceChainError('base'),
      );
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await expect(processor.process(makeJob())).resolves.not.toThrow();
      expect(systemService.setMeta).toHaveBeenCalled(); // meta still written
    });

    it('swallows generic adapter errors and continues', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'base',
        EXPECTED_SAFE_OWNERS_BASE: '0xownerA',
        EXPECTED_SAFE_THRESHOLD_BASE: '1',
        SAFE_ADDRESS_BASE: '0xSafe',
      });
      (safeTxService.getSafeInfo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network timeout'));
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await expect(processor.process(makeJob())).resolves.not.toThrow();
    });

    it('still writes meta key when adapter throws', async () => {
      const config = makeConfigService({
        ACTIVE_CHAINS: 'base',
        EXPECTED_SAFE_OWNERS_BASE: '0xownerA',
        EXPECTED_SAFE_THRESHOLD_BASE: '1',
        SAFE_ADDRESS_BASE: '0xSafe',
      });
      (safeTxService.getSafeInfo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('rpc unavailable'));
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(systemService.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'last_governance_drift_at' }));
    });
  });

  // -------------------------------------------------------------------------
  // Meta key always written
  // -------------------------------------------------------------------------

  describe('meta key invariant', () => {
    it('always writes last_governance_drift_at on successful run', async () => {
      const config = makeConfigService();
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      expect(systemService.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'last_governance_drift_at' }));
    });

    it('meta value is a valid ISO timestamp string', async () => {
      const config = makeConfigService();
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      await processor.process(makeJob());

      const callArg = (systemService.setMeta as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        value: string;
      };
      expect(callArg?.value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('result.skipped is false on normal run', async () => {
      const config = makeConfigService({ ACTIVE_CHAINS: '' });
      const processor = makeProcessor(config, safeTxService, squadsRpc, notificationsService, systemService);

      const result = await processor.process(makeJob());

      expect(result.skipped).toBe(false);
    });
  });
});
