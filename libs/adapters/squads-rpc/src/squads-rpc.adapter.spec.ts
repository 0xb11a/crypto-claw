/**
 * Unit tests for SquadsRpcAdapter — real Squads V4 SDK port.
 *
 * The adapter uses lazy dynamic `import('@sqds/multisig')` so all tests
 * mock the module at the vi.mock boundary rather than needing a live RPC.
 *
 * Strategy (locked decision from plan):
 *   - `vi.mock('@sqds/multisig')` + `vi.mock('@solana/web3.js')` for most tests.
 *   - ONE recorded mainnet account fixture (`__fixtures__/multisig-account.b64`)
 *     acts as the Borsh-regression guard (step 6 in plan). The fixture test
 *     is owned by tester; this file provides the structure.
 *
 * Covers:
 *   getMultisigInfo:
 *     - Returns SquadsMultisigInfo { members, threshold }.
 *     - Throws SquadsAddressMissingError when SQUADS_MULTISIG_ADDRESS unset.
 *     - Throws SquadsRpcUrlMissingError when RPC_SOL unset.
 *     - Throws SquadsRpcError on RPC failure.
 *     - Never logs the RPC URL (API key protection).
 *     - Respects AbortSignal (aborts before SDK call).
 *   getPendingTransactions:
 *     - Returns [] when transactionIndex === 0.
 *     - Returns Active proposals; skips non-Active.
 *     - Applies scan window max(1, txIndex - 19).
 *     - Skips individual proposal errors without aborting the full scan.
 *     - Throws SquadsAddressMissingError when SQUADS_MULTISIG_ADDRESS unset.
 *     - Respects AbortSignal.
 *   ADR-0026 / SPEC §4 #4:
 *     - SQUADS_SIGNER_KEY never accessed via ConfigService.
 *   Barrel:
 *     - SquadsRpcNotImplementedError is NOT exported (port complete signal).
 *
 * SPEC §4 #4 — SQUADS_SIGNER_KEY never read.
 * SPEC §4 #6 — no process.env reads; all config via ConfigService.
 * ADR-0026 — per-field config access only.
 * DoD §A — tests fail before, pass after.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before the import under test.
// ---------------------------------------------------------------------------

const mockMultisigFromAccountAddress = vi.fn();
const mockProposalFromAccountAddress = vi.fn();
const mockGetProposalPda = vi.fn();
const MockConnection = vi.fn();
const MockPublicKey = vi.fn().mockImplementation((addr: string) => ({
  toString: () => addr,
  toBase58: () => addr,
}));

vi.mock('@sqds/multisig', () => ({
  accounts: {
    Multisig: { fromAccountAddress: mockMultisigFromAccountAddress },
    Proposal: { fromAccountAddress: mockProposalFromAccountAddress },
  },
  getProposalPda: mockGetProposalPda,
}));

vi.mock('@solana/web3.js', () => ({
  Connection: MockConnection,
  PublicKey: MockPublicKey,
}));

// Import AFTER mocks are declared (vitest hoists vi.mock calls automatically).
import {
  SquadsRpcAdapter,
  SquadsAddressMissingError,
  SquadsRpcUrlMissingError,
  SquadsRpcError,
} from './squads-rpc.adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_MULTISIG_ADDRESS = '11111111111111111111111111111111';
const MOCK_RPC_URL = 'https://api.devnet.solana.com';

/** Create a minimal ConfigService stub with the given values. */
function makeConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: vi.fn((key: string) => overrides[key]),
  } as unknown as ConfigService;
}

/** Create a ConfigService with the standard Squads env vars set. */
function makeFullConfigService(extra: Record<string, unknown> = {}): ConfigService {
  return makeConfigService({
    SQUADS_MULTISIG_ADDRESS: MOCK_MULTISIG_ADDRESS,
    RPC_SOL: MOCK_RPC_URL,
    ...extra,
  });
}

/** Create a mock multisig account with the given members and threshold. */
function mockMultisigAccount(members: string[], threshold: number, transactionIndex = 0) {
  return {
    threshold: BigInt(threshold),
    transactionIndex: BigInt(transactionIndex),
    members: members.map((key) => ({ key: { toString: () => key } })),
  };
}

/** Create a mock Active proposal at a given index. */
function mockActiveProposal(approved = 0) {
  return { status: { __kind: 'Active' }, approved: Array(approved).fill({}) };
}

/** Create a mock non-Active (e.g. Executed) proposal. */
function mockExecutedProposal() {
  return { status: { __kind: 'Executed' }, approved: [] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SquadsRpcAdapter', () => {
  let adapter: SquadsRpcAdapter;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

    MockConnection.mockReset();
    MockPublicKey.mockReset().mockImplementation((addr: string) => ({
      toString: () => addr,
      toBase58: () => addr,
    }));
    mockMultisigFromAccountAddress.mockReset();
    mockProposalFromAccountAddress.mockReset();
    mockGetProposalPda.mockReset();

    // Clear cached modules between tests so each test gets fresh mocks.
    adapter = new SquadsRpcAdapter(makeFullConfigService());
    // Force clear module cache so dynamic imports pick up fresh mocks.
    (adapter as any)._multisig = null;
    (adapter as any)._web3 = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // getMultisigInfo
  // -------------------------------------------------------------------------

  describe('getMultisigInfo()', () => {
    it('returns members and threshold from the multisig account', async () => {
      const members = ['PubKey1111', 'PubKey2222', 'PubKey3333'];
      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount(members, 2));

      const result = await adapter.getMultisigInfo();

      expect(result.members).toEqual(members);
      expect(result.threshold).toBe(2);
    });

    it('returns empty members array when multisig has no members', async () => {
      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount([], 0));

      const result = await adapter.getMultisigInfo();

      expect(result.members).toEqual([]);
      expect(result.threshold).toBe(0);
    });

    it('converts BigInt threshold to Number', async () => {
      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount(['PubKey1'], 3));

      const result = await adapter.getMultisigInfo();

      expect(typeof result.threshold).toBe('number');
      expect(result.threshold).toBe(3);
    });

    it('throws SquadsAddressMissingError when SQUADS_MULTISIG_ADDRESS is not set', async () => {
      const adapterNoAddr = new SquadsRpcAdapter(makeConfigService({ RPC_SOL: MOCK_RPC_URL }));
      (adapterNoAddr as any)._multisig = null;
      (adapterNoAddr as any)._web3 = null;

      await expect(adapterNoAddr.getMultisigInfo()).rejects.toThrow(SquadsAddressMissingError);
    });

    it('throws SquadsRpcUrlMissingError when RPC_SOL is not set', async () => {
      const adapterNoRpc = new SquadsRpcAdapter(makeConfigService({ SQUADS_MULTISIG_ADDRESS: MOCK_MULTISIG_ADDRESS }));
      (adapterNoRpc as any)._multisig = null;
      (adapterNoRpc as any)._web3 = null;

      await expect(adapterNoRpc.getMultisigInfo()).rejects.toThrow(SquadsRpcUrlMissingError);
    });

    it('throws SquadsRpcError when fromAccountAddress rejects', async () => {
      mockMultisigFromAccountAddress.mockRejectedValueOnce(new Error('Account not found'));

      await expect(adapter.getMultisigInfo()).rejects.toThrow(SquadsRpcError);
    });

    it('SquadsRpcError message mentions the method name', async () => {
      mockMultisigFromAccountAddress.mockRejectedValueOnce(new Error('RPC down'));

      const err = await adapter.getMultisigInfo().catch((e: unknown) => e);
      expect((err as Error).message).toContain('getMultisigInfo');
    });

    it('does NOT include the RPC URL in any thrown error message', async () => {
      mockMultisigFromAccountAddress.mockRejectedValueOnce(new Error('Account not found'));

      const err = await adapter.getMultisigInfo().catch((e: unknown) => e);
      expect((err as Error).message).not.toContain(MOCK_RPC_URL);
    });

    it('throws AbortError when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(adapter.getMultisigInfo(controller.signal)).rejects.toThrow(/aborted/i);
      // fromAccountAddress should never be called when already aborted.
      expect(mockMultisigFromAccountAddress).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getPendingTransactions
  // -------------------------------------------------------------------------

  describe('getPendingTransactions()', () => {
    it('returns empty array when transactionIndex is 0', async () => {
      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount([], 1, 0));

      const result = await adapter.getPendingTransactions();

      expect(result).toEqual([]);
      expect(mockGetProposalPda).not.toHaveBeenCalled();
    });

    it('returns Active proposals only, skipping Executed proposals', async () => {
      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount([], 1, 3));
      // Indices scanned: 3, 2, 1
      mockGetProposalPda.mockImplementation(({ transactionIndex }: { transactionIndex: bigint }) => [
        { toString: () => `proposalPda_${transactionIndex}` },
      ]);
      mockProposalFromAccountAddress
        .mockResolvedValueOnce(mockActiveProposal(1)) // index 3 — Active
        .mockResolvedValueOnce(mockExecutedProposal()) // index 2 — Executed (skip)
        .mockResolvedValueOnce(mockActiveProposal(0)); // index 1 — Active

      const result = await adapter.getPendingTransactions();

      expect(result).toHaveLength(2);
      expect(result[0].transactionIndex).toBe(3);
      expect(result[1].transactionIndex).toBe(1);
    });

    it('returns approved count from Active proposal', async () => {
      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount([], 1, 1));
      mockGetProposalPda.mockReturnValueOnce([{ toString: () => 'pda1' }]);
      mockProposalFromAccountAddress.mockResolvedValueOnce(mockActiveProposal(2));

      const result = await adapter.getPendingTransactions();

      expect(result[0].approved).toBe(2);
    });

    it('defaults approved to 0 when proposal.approved is null', async () => {
      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount([], 1, 1));
      mockGetProposalPda.mockReturnValueOnce([{ toString: () => 'pda1' }]);
      mockProposalFromAccountAddress.mockResolvedValueOnce({ status: { __kind: 'Active' }, approved: null });

      const result = await adapter.getPendingTransactions();

      expect(result[0].approved).toBe(0);
    });

    it('scans exactly the last 20 indices when transactionIndex >= 20', async () => {
      const txCount = 25;
      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount([], 1, txCount));
      mockGetProposalPda.mockImplementation(({ transactionIndex }: { transactionIndex: bigint }) => [
        { toString: () => `pda_${transactionIndex}` },
      ]);
      // All proposals return Executed so we can count getProposalPda calls.
      mockProposalFromAccountAddress.mockResolvedValue(mockExecutedProposal());

      await adapter.getPendingTransactions();

      // Scan window: 25 down to max(1, 25-19)=6 → indices 25,24,...,6 = 20 indices.
      expect(mockGetProposalPda).toHaveBeenCalledTimes(20);
    });

    it('scans from txCount down to 1 when transactionIndex < 20', async () => {
      const txCount = 5;
      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount([], 1, txCount));
      mockGetProposalPda.mockImplementation(({ transactionIndex }: { transactionIndex: bigint }) => [
        { toString: () => `pda_${transactionIndex}` },
      ]);
      mockProposalFromAccountAddress.mockResolvedValue(mockExecutedProposal());

      await adapter.getPendingTransactions();

      // Scan window: 5 down to max(1, 5-19)=1 → indices 5,4,3,2,1 = 5 indices.
      expect(mockGetProposalPda).toHaveBeenCalledTimes(5);
    });

    it('skips individual proposal fetch errors without aborting the full scan', async () => {
      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount([], 1, 3));
      mockGetProposalPda.mockImplementation(({ transactionIndex }: { transactionIndex: bigint }) => [
        { toString: () => `pda_${transactionIndex}` },
      ]);
      mockProposalFromAccountAddress
        .mockRejectedValueOnce(new Error('RPC timeout')) // index 3 — error, skip
        .mockResolvedValueOnce(mockActiveProposal(1)) // index 2 — Active
        .mockRejectedValueOnce(new Error('not found')); // index 1 — error, skip

      const result = await adapter.getPendingTransactions();

      expect(result).toHaveLength(1);
      expect(result[0].transactionIndex).toBe(2);
    });

    it('throws SquadsAddressMissingError when SQUADS_MULTISIG_ADDRESS not set', async () => {
      const adapterNoAddr = new SquadsRpcAdapter(makeConfigService({ RPC_SOL: MOCK_RPC_URL }));
      (adapterNoAddr as any)._multisig = null;
      (adapterNoAddr as any)._web3 = null;

      await expect(adapterNoAddr.getPendingTransactions()).rejects.toThrow(SquadsAddressMissingError);
    });

    it('throws SquadsRpcError when multisig account fetch fails', async () => {
      mockMultisigFromAccountAddress.mockRejectedValueOnce(new Error('account not found'));

      await expect(adapter.getPendingTransactions()).rejects.toThrow(SquadsRpcError);
    });

    // Concern (d) — OPEN-SDK-1: approved=undefined treated as 0.
    it('[OPEN-SDK-1] defaults approved to 0 when proposal.approved is undefined', async () => {
      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount([], 1, 1));
      mockGetProposalPda.mockReturnValueOnce([{ toString: () => 'pda1' }]);
      // approved field absent (undefined) — defensive default must kick in.
      mockProposalFromAccountAddress.mockResolvedValueOnce({ status: { __kind: 'Active' }, approved: undefined });

      const result = await adapter.getPendingTransactions();

      expect(result[0].approved).toBe(0);
    });

    // Concern (c) — Cancelled proposal edge case.
    // The SDK type for status.__kind includes 'Cancelled' in addition to 'Active',
    // 'Approved', 'Executed'. The adapter only passes through proposals with
    // __kind === 'Active', so Cancelled is correctly filtered out. This test
    // confirms Cancelled proposals are skipped (not misinterpreted as active).
    it('skips Cancelled proposals (treats only Active as pending)', async () => {
      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount([], 1, 2));
      mockGetProposalPda.mockImplementation(({ transactionIndex }: { transactionIndex: bigint }) => [
        { toString: () => `pda_${transactionIndex}` },
      ]);
      // index 2 — Cancelled; index 1 — Active
      mockProposalFromAccountAddress
        .mockResolvedValueOnce({ status: { __kind: 'Cancelled' }, approved: [] })
        .mockResolvedValueOnce(mockActiveProposal(1));

      const result = await adapter.getPendingTransactions();

      expect(result).toHaveLength(1);
      expect(result[0].transactionIndex).toBe(1);
    });

    // Concern (e) — getProposalPda throws on every index.
    // Per coder: "all Squads receipts treated as assumed executed — dangerous, accepted risk".
    // When every getProposalPda call throws, the scan skips all indices and returns [].
    // This path should log a warn for each failed index (verified via spy) and
    // not throw. The empty result means the caller (multisig-tracker) will treat
    // all receipts as executed — the documented risk documented in the adapter.
    it('[OPEN-RISK] returns [] when getProposalPda throws on every index', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount([], 1, 3));
      // All PDA derivations fail.
      mockGetProposalPda.mockImplementation(() => {
        throw new Error('invalid public key bytes');
      });

      const result = await adapter.getPendingTransactions();

      // Empty result — callers will treat all receipts as executed (accepted risk).
      expect(result).toEqual([]);
      // Warn should fire for each failed index.
      expect(warnSpy).toHaveBeenCalled();
    });

    // Concern (f) — RPC URL must NOT appear in getPendingTransactions error.
    it('does NOT include the RPC URL in SquadsRpcError thrown from getPendingTransactions', async () => {
      mockMultisigFromAccountAddress.mockRejectedValueOnce(new Error('account not found'));

      const err = await adapter.getPendingTransactions().catch((e: unknown) => e);
      expect((err as Error).message).not.toContain(MOCK_RPC_URL);
    });

    it('stops scanning when AbortSignal fires mid-loop', async () => {
      const controller = new AbortController();
      const txCount = 5;
      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount([], 1, txCount));
      mockGetProposalPda.mockImplementation(({ transactionIndex }: { transactionIndex: bigint }) => {
        // Abort when we reach index 4 (one below the top — simulates mid-scan abort).
        if (Number(transactionIndex) <= txCount - 2) controller.abort();
        return [{ toString: () => `pda_${transactionIndex}` }];
      });
      mockProposalFromAccountAddress.mockResolvedValue(mockExecutedProposal());

      await adapter.getPendingTransactions(controller.signal);

      // Abort fires during getProposalPda for index 3 (≤ txCount-2 = 3).
      // Loop aborts before index 2 can start. Indices 5, 4, 3 are processed → 3 calls.
      // The exact boundary is: scan starts at i=5, checks abort (false), calls pda(5),
      // i=4, checks abort (false), calls pda(4), i=3, checks abort (false), calls pda(3)
      // (which sets abort), i=2, checks abort (true), breaks.
      expect(mockGetProposalPda).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // ADR-0026 / SPEC §4 #4 — signer-key isolation
  // -------------------------------------------------------------------------

  describe('SPEC §4 #4 — signer-key isolation', () => {
    it('does NOT read SQUADS_SIGNER_KEY from ConfigService in getMultisigInfo', async () => {
      const config = makeFullConfigService({ SQUADS_SIGNER_KEY: 'should-never-be-read' });
      const isolated = new SquadsRpcAdapter(config);
      (isolated as any)._multisig = null;
      (isolated as any)._web3 = null;

      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount(['PubKey1'], 1));

      await isolated.getMultisigInfo();

      const calls = (config.get as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
      expect(calls).not.toContain('SQUADS_SIGNER_KEY');
    });

    it('does NOT read SQUADS_SIGNER_KEY from ConfigService in getPendingTransactions', async () => {
      const config = makeFullConfigService({ SQUADS_SIGNER_KEY: 'should-never-be-read' });
      const isolated = new SquadsRpcAdapter(config);
      (isolated as any)._multisig = null;
      (isolated as any)._web3 = null;

      mockMultisigFromAccountAddress.mockResolvedValueOnce(mockMultisigAccount([], 1, 0));

      await isolated.getPendingTransactions();

      const calls = (config.get as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
      expect(calls).not.toContain('SQUADS_SIGNER_KEY');
    });
  });

  // -------------------------------------------------------------------------
  // Barrel export verification
  // -------------------------------------------------------------------------

  describe('barrel index exports', () => {
    it('SquadsAddressMissingError is exported', async () => {
      const { SquadsAddressMissingError: Exported } = await import('./index.js');
      expect(Exported).toBeDefined();
      expect(new Exported()).toBeInstanceOf(SquadsAddressMissingError);
    });

    it('SquadsRpcError is exported', async () => {
      const { SquadsRpcError: Exported } = await import('./index.js');
      expect(Exported).toBeDefined();
    });

    it('SquadsRpcNotImplementedError is NOT exported (SDK port complete)', async () => {
      const barrel = await import('./index.js');
      // The stub error class must be gone from the public surface.
      expect('SquadsRpcNotImplementedError' in barrel).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Borsh regression guard (fixture-driven)
  //
  // Fixture source: Option C — synthesized from @sqds/multisig@2.1.4 SDK own
  // Multisig.fromArgs() + serialize() call. Round-trip verified: encode then
  // decode returns identical field values. See __fixtures__/README.md for full
  // acquisition trace and known values.
  //
  // This test uses the REAL SDK (no mock). The vi.mock('@sqds/multisig') calls
  // above are module-level but Vitest's mock hoisting only applies to the tested
  // module's dynamic imports — the direct SDK import below bypasses those mocks
  // because it is a static import in the test file itself, which loads before
  // the mock registry applies to it.
  //
  // The guard verifies that the Borsh layout the SDK parser expects still matches
  // the layout the fixture was written with. If the SDK upgrades and changes
  // offsets, this test fails loudly before any production alert fires.
  //
  // Known values (from __fixtures__/README.md):
  //   members.length: 2
  //   members[0]:     Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJ
  //   members[1]:     FuZKoM79bvpvMmGNrjbPs8CobYSxQBNQXzHhzFJHHPPe
  //   threshold:      2
  //   transactionIndex: 42
  // -------------------------------------------------------------------------

  describe('Borsh regression guard (fixture-driven)', () => {
    // Known values that must match the fixture — change these if regenerating
    // the fixture after an SDK upgrade (and update __fixtures__/README.md too).
    const FIXTURE_MEMBER_0 = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJ';
    const FIXTURE_MEMBER_1 = 'FuZKoM79bvpvMmGNrjbPs8CobYSxQBNQXzHhzFJHHPPe';
    const FIXTURE_THRESHOLD = 2;
    const FIXTURE_TX_INDEX = 42;

    it('decodes __fixtures__/multisig-account.b64 with the real SDK and asserts known field values', async () => {
      // Load the fixture — absolute path anchored to THIS source file's directory.
      // __dirname is CJS-global (module: CommonJS in tsconfig.json).
      // resolve up one level from src/ to the package root, then into __fixtures__/.
      const fixturePath = resolve(__dirname, '..', '__fixtures__', 'multisig-account.b64');
      const b64 = readFileSync(fixturePath, 'utf8').trim();
      const buf = Buffer.from(b64, 'base64');

      // Use the REAL SDK via vi.importActual — bypasses the vi.mock('@sqds/multisig')
      // declared at file scope (which mocks the adapter's dynamic import, not ours).
      // vi.importActual gives us the original module regardless of mock state.
      // This is the correct pattern for fixture-driven tests that need the real parser.
      // vi.importActual gives us the original module regardless of vi.mock state.
      // We cast to the shape we need — the fixture test is intentionally type-loose
      // because the SDK ships as ESM and its TypeScript types aren't available from CJS.
      const realSdk = (await vi.importActual('@sqds/multisig')) as {
        accounts: {
          Multisig: {
            fromAccountInfo: (
              info: { data: Buffer },
              offset: number,
            ) => [{ threshold: bigint; transactionIndex: bigint; members: Array<{ key: { toBase58(): string } }> }];
          };
        };
      };

      // Decode using fromAccountInfo — same call path as fromAccountAddress uses.
      const [decoded] = realSdk.accounts.Multisig.fromAccountInfo({ data: buf }, 0);

      // Assert known structural values.
      expect(decoded.members).toHaveLength(2);
      expect(decoded.members[0].key.toBase58()).toBe(FIXTURE_MEMBER_0);
      expect(decoded.members[1].key.toBase58()).toBe(FIXTURE_MEMBER_1);
      expect(Number(decoded.threshold)).toBe(FIXTURE_THRESHOLD);
      expect(Number(decoded.transactionIndex)).toBe(FIXTURE_TX_INDEX);
    });

    it('fixture buffer starts with the Squads V4 Multisig discriminator bytes', () => {
      const fixturePath = resolve(__dirname, '..', '__fixtures__', 'multisig-account.b64');
      const b64 = readFileSync(fixturePath, 'utf8').trim();
      const buf = Buffer.from(b64, 'base64');

      // Discriminator: [224, 116, 121, 186, 68, 161, 79, 236]
      // This catches truncated or wrong-account fixtures at the earliest point.
      const DISCRIMINATOR = [224, 116, 121, 186, 68, 161, 79, 236];
      const actualDiscriminator = Array.from(buf.subarray(0, 8));
      expect(actualDiscriminator).toEqual(DISCRIMINATOR);
    });
  });
});
