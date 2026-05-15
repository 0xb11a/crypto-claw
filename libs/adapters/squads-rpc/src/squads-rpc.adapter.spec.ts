/**
 * Unit tests for SquadsRpcAdapter (SPEC §14, DoD §A).
 *
 * The adapter is a stub: both methods ALWAYS throw SquadsRpcNotImplementedError.
 * Consumer processors guard the Solana branch with an explicit feature-flag skip
 * BEFORE calling any adapter method, so these errors never reach production.
 * The throw-on-call behaviour is defence-in-depth.
 *
 * SDK port rationale (see squads-rpc.adapter.ts JSDoc for full context):
 *   - getPendingTransactions previously used { dataSize: 0 } placeholder that always
 *     returned [], causing every queued_in_squads receipt to be falsely executed.
 *   - parseMultisigAccountData had wrong Borsh offsets, producing garbage data.
 *   - Reviewer chose option (b): stub + explicit Solana skip in both consumers.
 *
 * Covers (6 tests):
 *   getMultisigInfo:
 *     - Always throws SquadsRpcNotImplementedError.
 *     - error.name === 'SquadsRpcNotImplementedError'.
 *     - Error message mentions the SDK port (@sqds/multisig).
 *   getPendingTransactions:
 *     - Always throws SquadsRpcNotImplementedError.
 *   Barrel export:
 *     - SquadsRpcNotImplementedError exported from barrel index.
 *   ADR-0026 / SPEC §4 #4:
 *     - SQUADS_SIGNER_KEY is never read (not accessed before the throw).
 *
 * Dropped tests: Borsh parsing, RPC error handling, pending-tx filtering,
 * HTTP-status variants — all obsolete since no fetch/RPC call is made.
 *
 * SPEC §4 #4 — SQUADS_SIGNER_KEY never read.
 * SPEC §4 #6 — no process.env reads; all config via ConfigService.
 * ADR-0026 — per-field config access only.
 * DoD §A — tests fail before, pass after.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SquadsRpcAdapter, SquadsRpcNotImplementedError } from './squads-rpc.adapter.js';
import { SquadsRpcNotImplementedError as SquadsRpcNotImplementedErrorBarrel } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: vi.fn((key: string) => overrides[key]),
  } as unknown as ConfigService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SquadsRpcAdapter — stub (SDK port pending)', () => {
  let adapter: SquadsRpcAdapter;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    adapter = new SquadsRpcAdapter(makeConfigService());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // getMultisigInfo — always throws NotImplementedError
  // -------------------------------------------------------------------------

  describe('getMultisigInfo()', () => {
    it('always throws SquadsRpcNotImplementedError', async () => {
      await expect(adapter.getMultisigInfo()).rejects.toThrow(SquadsRpcNotImplementedError);
    });

    it('error.name is SquadsRpcNotImplementedError', async () => {
      const err = await adapter.getMultisigInfo().catch((e: unknown) => e);
      expect((err as Error).name).toBe('SquadsRpcNotImplementedError');
    });

    it('error message mentions @sqds/multisig (SDK port reference)', async () => {
      const err = await adapter.getMultisigInfo().catch((e: unknown) => e);
      expect((err as Error).message).toContain('@sqds/multisig');
    });
  });

  // -------------------------------------------------------------------------
  // getPendingTransactions — always throws NotImplementedError
  // -------------------------------------------------------------------------

  describe('getPendingTransactions()', () => {
    it('always throws SquadsRpcNotImplementedError', async () => {
      await expect(adapter.getPendingTransactions()).rejects.toThrow(SquadsRpcNotImplementedError);
    });
  });

  // -------------------------------------------------------------------------
  // Barrel export
  // -------------------------------------------------------------------------

  describe('barrel index exports', () => {
    it('SquadsRpcNotImplementedError is exported from the barrel index', () => {
      expect(SquadsRpcNotImplementedErrorBarrel).toBeDefined();
      // Should be the same constructor
      expect(SquadsRpcNotImplementedErrorBarrel).toBe(SquadsRpcNotImplementedError);
    });
  });

  // -------------------------------------------------------------------------
  // ADR-0026 / SPEC §4 #4 — SQUADS_SIGNER_KEY never read
  //
  // Even as a stub, the adapter must not access SQUADS_SIGNER_KEY via
  // ConfigService before throwing. The constructor takes ConfigService in the
  // DI graph but the implementation must not read the signer key.
  // -------------------------------------------------------------------------

  describe('ADR-0026 / SPEC §4 #4 — signer-key isolation', () => {
    it('does NOT read SQUADS_SIGNER_KEY from ConfigService (even as a stub)', async () => {
      const config = makeConfigService({ SQUADS_SIGNER_KEY: 'should-never-be-read' });
      const isolatedAdapter = new SquadsRpcAdapter(config);

      // Swallow the expected NotImplementedError — we're asserting the key was never read.
      await isolatedAdapter.getMultisigInfo().catch(() => {});

      const calls = (config.get as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
      expect(calls).not.toContain('SQUADS_SIGNER_KEY');
    });
  });
});
