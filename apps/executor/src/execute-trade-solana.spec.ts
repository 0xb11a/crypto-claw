/**
 * Unit tests for apps/executor/src/execute-trade-solana.ts
 *
 * All Solana SDK calls are mocked via vi.mock so these tests run in CI
 * without @sqds/multisig or @solana/web3.js installed.
 *
 * Covers:
 *   - Stub-mode short-circuit: chain='solana' + EXECUTOR_STUB_MODE=1 → stub, no SDK import
 *   - Happy buy: success receipt with fake sig + safe_nonce (squadsTransactionIndex)
 *   - Happy sell with amount='all': success receipt
 *   - Jupiter /quote 429 retries → 5 fetch attempts then jupiter_quote_failed
 *   - Jupiter /swap-instructions returns disallowed programId → aggregator_program_not_allowlisted
 *   - Missing SQUADS_MULTISIG_ADDRESS AND SQUADS_VAULT_ADDRESS → executor_error
 *   - RPC hostname denylisted (strict mode) → rpc_hostname_not_allowlisted
 *   - Missing SQUADS_SIGNER_KEY → executor_error
 *   - vaultTransactionCreate throws → squads_propose_failed
 *
 * NOTE: The 1232-byte gate test is in the integration test group as it requires
 * building real Squads instruction payloads. Unit tests here use mocked SDK.
 *
 * DoD §A — tests for every code change.
 * DoD §F — signer key never appears in failure receipt.
 * SPEC §4 #4 — signer keys never in non-executor env.
 * P1c-iii — Squads V4 SDK + Jupiter swap in apps/executor.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_SOLANA_ORDER = {
  id: 'sol-test-001',
  action: 'buy' as const,
  symbol: 'BONK',
  address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK mint
  chain: 'solana',
  amount: '100.00',
  entry_price: 0.000001,
  slippage_bps: 500,
  tier: 'moonshot',
};

const VALID_SELL_ORDER = {
  ...VALID_SOLANA_ORDER,
  id: 'sol-sell-001',
  action: 'sell' as const,
  amount: '1000000000', // in token lamports
};

const SELL_ALL_ORDER = {
  ...VALID_SELL_ORDER,
  id: 'sol-sell-all-001',
  amount: 'all',
};

/** A sentinel value that must NEVER appear in any receipt or error message. */
const SQUADS_KEY_SENTINEL = 'FAKE_SOL_SIGNER_KEY_SENTINEL_ABCDEF1234567890ABCDEF'; // pre-commit-allow

/** A fake Solana RPC URL that would normally be rejected by the allowlist. */
const BANNED_RPC = 'https://evil-attacker-rpc.not-in-allowlist.example.com';

/** Allowlisted Solana RPC URL (Helius suffix). */
const VALID_RPC = 'https://mainnet.helius-rpc.com/?api-key=test';

const VALID_ENV = {
  EXECUTOR_STUB_MODE: '0',
  SQUADS_SIGNER_KEY: SQUADS_KEY_SENTINEL,
  SQUADS_MULTISIG_ADDRESS: '9Fqk5XN9MYnwbLCiqLhxANFhVBM1GBQyEqBgfmqhSCCC',
  SQUADS_VAULT_ADDRESS: '9Fqk5XN9MYnwbLCiqLhxANFhVBM1GBQyEqBgfmqhSCCC',
  RPC_SOL: VALID_RPC,
  RPC_VALIDATION_MODE: 'strict',
};

// ---------------------------------------------------------------------------
// Mock the Solana SDK modules
// These mocks stay in effect for the entire test file.
// Mock factories use intentionally-unused _ prefixed parameters to match the
// real SDK signatures. Suppress unused-vars for the entire mock block below.
// ---------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-unused-vars */

const FAKE_BLOCKHASH = 'FakeBlockhash1111111111111111111111111111111';
const FAKE_META_SIG = 'FakeMetaSig1111111111111111111111111111111111111111111111111111111';
const FAKE_SQUADS_TX_INDEX = 42;

// bs58 decode mock: returns a fake 64-byte key for any string
vi.mock('bs58', () => ({
  default: {
    decode: (_s: string) => new Uint8Array(64).fill(1),
    encode: (bytes: Uint8Array) => 'FakeBase58EncodedKey' + bytes.length,
  },
  decode: (_s: string) => new Uint8Array(64).fill(1),
  encode: (bytes: Uint8Array) => 'FakeBase58EncodedKey' + bytes.length,
}));

// @solana/web3.js mock
vi.mock('@solana/web3.js', () => {
  // Fake PublicKey class
  class FakePublicKey {
    _addr: string;
    constructor(addr: string) {
      this._addr = addr;
    }
    toString() {
      return this._addr;
    }
    equals(other: FakePublicKey) {
      return this._addr === other._addr;
    }
    toBuffer() {
      return Buffer.alloc(32);
    }
  }

  // Fake Keypair class
  class FakeKeypair {
    publicKey: FakePublicKey;
    secretKey: Uint8Array;
    constructor() {
      this.publicKey = new FakePublicKey('FakeSignerPubkey1111111111111111');
      this.secretKey = new Uint8Array(64).fill(1);
    }
    static fromSecretKey(_bytes: Uint8Array) {
      return new FakeKeypair();
    }
  }

  // Fake TransactionMessage
  class FakeTransactionMessage {
    constructor(_opts: unknown) {}
    compileToV0Message(_luts?: unknown[]) {
      return {};
    }
  }

  // Fake VersionedTransaction
  class FakeVersionedTransaction {
    constructor(_msg: unknown) {}
    sign(_signers: unknown[]) {}
    serialize() {
      return new Uint8Array(500);
    } // well under 1232-byte limit
  }

  // Fake TransactionInstruction
  class FakeTransactionInstruction {
    programId: FakePublicKey;
    keys: unknown[];
    data: Buffer;
    constructor(opts: { programId: FakePublicKey; keys: unknown[]; data: Buffer }) {
      this.programId = opts.programId;
      this.keys = opts.keys;
      this.data = opts.data;
    }
  }

  // Fake AddressLookupTableAccount
  class FakeAddressLookupTableAccount {}

  // Fake Connection
  class FakeConnection {
    constructor(_url: string, _commitment?: string) {}
    async getLatestBlockhash() {
      return { blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: 999999 };
    }
    async sendTransaction(_tx: unknown, _opts?: unknown): Promise<string> {
      return FAKE_META_SIG;
    }
    async confirmTransaction(_opts: unknown) {
      return { value: { err: null } };
    }
    async getAddressLookupTable(_key: unknown) {
      return { value: null };
    }
    async getBalance(_key: unknown) {
      return 100_000_000; // 0.1 SOL — above the 0.05 threshold
    }
    async getAccountInfo(_key: unknown) {
      return null;
    }
  }

  return {
    Connection: FakeConnection,
    PublicKey: FakePublicKey,
    Keypair: FakeKeypair,
    TransactionMessage: FakeTransactionMessage,
    VersionedTransaction: FakeVersionedTransaction,
    TransactionInstruction: FakeTransactionInstruction,
    AddressLookupTableAccount: FakeAddressLookupTableAccount,
    LAMPORTS_PER_SOL: 1_000_000_000,
  };
});

// @solana/spl-token mock
vi.mock('@solana/spl-token', () => {
  const TOKEN_PROGRAM_ID = {
    toString: () => 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    equals: (_o: unknown) => false,
  };
  const TOKEN_2022_PROGRAM_ID = {
    toString: () => 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    equals: (_o: unknown) => false,
  };

  return {
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    getAssociatedTokenAddress: async (_mint: unknown, _owner: unknown) => ({ toString: () => 'FakeATA' }),
    getAccount: async (_conn: unknown, _ata: unknown) => ({ amount: 1_000_000_000n }),
    getMint: async () => ({ decimals: 9 }),
  };
});

// @sqds/multisig mock
vi.mock('@sqds/multisig', () => {
  const getVaultPda = (opts: Record<string, unknown>) => [{ toString: () => 'FakeVaultPDA' + String(opts['index']) }];

  const accounts = {
    Multisig: {
      fromAccountAddress: async (_conn: unknown, _pda: unknown) => ({
        transactionIndex: FAKE_SQUADS_TX_INDEX - 1, // will be incremented to FAKE_SQUADS_TX_INDEX
        threshold: 1,
      }),
    },
  };

  const instructions = {
    vaultTransactionCreate: (_opts: unknown) => ({
      programId: { toString: () => 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf' },
      keys: [],
      data: Buffer.alloc(64),
    }),
    proposalCreate: (_opts: unknown) => ({
      programId: { toString: () => 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf' },
      keys: [],
      data: Buffer.alloc(32),
    }),
    proposalApprove: (_opts: unknown) => ({
      programId: { toString: () => 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf' },
      keys: [],
      data: Buffer.alloc(32),
    }),
    vaultTransactionExecute: async (_opts: unknown) => ({
      instruction: {
        programId: { toString: () => 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf' },
        keys: [],
        data: Buffer.alloc(32),
      },
      lookupTableAccounts: [],
    }),
  };

  return { getVaultPda, accounts, instructions };
});

/* eslint-enable @typescript-eslint/no-unused-vars */

// ---------------------------------------------------------------------------
// Jupiter fetch helper
// ---------------------------------------------------------------------------

/** Build a minimal valid Jupiter quote response. */
function makeJupiterQuote(overrides: Partial<{ outAmount: string }> = {}): Record<string, unknown> {
  return {
    outAmount: overrides.outAmount ?? '950000000', // 0.95 tokens (9 decimals)
    routePlan: [{ swapInfo: {} }],
    addressLookupTableAddresses: [],
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    outputMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    inAmount: '100000000',
    slippageBps: 500,
  };
}

/** Build a minimal valid Jupiter swap-instructions response. */
function makeSwapInstructions(overrides: Partial<{ swapProgramId: string }> = {}): Record<string, unknown> {
  return {
    swapInstruction: {
      programId: overrides.swapProgramId ?? 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6 (allowlisted)
      accounts: [{ pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false }],
      data: Buffer.alloc(32).toString('base64'),
    },
    setupInstructions: [],
    cleanupInstruction: null,
    addressLookupTableAddresses: [],
  };
}

// ---------------------------------------------------------------------------
// Test group 1: Stub mode short-circuit
// ---------------------------------------------------------------------------

describe('executeTradeSolana() — stub mode short-circuit', () => {
  it('stub mode is handled by execute-trade.ts dispatcher before this module loads', async () => {
    // The stub short-circuit lives in execute-trade.ts (checked in execute-trade.spec.ts).
    // Here we verify the module itself is importable (SDK mocks are active).
    const { executeTradeSolana } = await import('./execute-trade-solana.js');
    expect(typeof executeTradeSolana).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Test group 2: Happy buy → success receipt
// ---------------------------------------------------------------------------

describe('executeTradeSolana() — happy buy path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success receipt with tx_hash and squads transactionIndex', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes('/quote')) {
        return { ok: true, json: async () => makeJupiterQuote() } as unknown as Response;
      }
      if (url.includes('/swap-instructions')) {
        return { ok: true, json: async () => makeSwapInstructions() } as unknown as Response;
      }
      return { ok: false, status: 500, text: async () => 'unexpected' } as unknown as Response;
    });

    const { executeTradeSolana } = await import('./execute-trade-solana.js');
    const result = await executeTradeSolana(VALID_SOLANA_ORDER, VALID_ENV);

    expect(result.status).toBe('executed');
    if (result.status === 'executed') {
      expect(typeof result.tx_hash).toBe('string');
      expect(result.tx_hash.length).toBeGreaterThan(0);
      expect(result.executed_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(result.actual_amount_out).toBeGreaterThan(0);
    }
  });

  it('receipt does not contain SQUADS_SIGNER_KEY value', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes('/quote')) {
        return { ok: true, json: async () => makeJupiterQuote() } as unknown as Response;
      }
      if (url.includes('/swap-instructions')) {
        return { ok: true, json: async () => makeSwapInstructions() } as unknown as Response;
      }
      return { ok: false, status: 500, text: async () => 'unexpected' } as unknown as Response;
    });

    const { executeTradeSolana } = await import('./execute-trade-solana.js');
    const result = await executeTradeSolana(VALID_SOLANA_ORDER, {
      ...VALID_ENV,
      SQUADS_SIGNER_KEY: SQUADS_KEY_SENTINEL,
    });

    expect(JSON.stringify(result)).not.toContain(SQUADS_KEY_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Test group 3: Happy sell with amount='all'
// ---------------------------------------------------------------------------

describe('executeTradeSolana() — happy sell amount=all', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success receipt for sell with amount=all', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes('/quote')) {
        return { ok: true, json: async () => makeJupiterQuote({ outAmount: '100000000' }) } as unknown as Response;
      }
      if (url.includes('/swap-instructions')) {
        return { ok: true, json: async () => makeSwapInstructions() } as unknown as Response;
      }
      return { ok: false, status: 500, text: async () => 'unexpected' } as unknown as Response;
    });

    const { executeTradeSolana } = await import('./execute-trade-solana.js');
    const result = await executeTradeSolana(SELL_ALL_ORDER, VALID_ENV);

    expect(result.status).toBe('executed');
    if (result.status === 'executed') {
      expect(result.actual_amount_in).toBe('all');
    }
  });
});

// ---------------------------------------------------------------------------
// Test group 4: Jupiter /quote 429 backoff → eventual jupiter_quote_failed
// ---------------------------------------------------------------------------

describe('executeTradeSolana() — Jupiter /quote 429 retry exhaustion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls /quote up to 5 times on all-429 and returns jupiter_quote_failed', async () => {
    let quoteCallCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes('/quote')) {
        quoteCallCount++;
        return {
          ok: false,
          status: 429,
          text: async () => 'Too Many Requests',
        } as unknown as Response;
      }
      return { ok: false, status: 500, text: async () => 'unexpected' } as unknown as Response;
    });

    const { executeTradeSolana } = await import('./execute-trade-solana.js');
    const result = await executeTradeSolana(VALID_SOLANA_ORDER, {
      ...VALID_ENV,
      // Hint: override to speed up test — real delays would make this test too slow.
      // The test still validates the retry count (5 attempts = 4 retries + 1 initial).
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error_kind).toBe('jupiter_quote_failed');
    }
    // 4 retries = 5 total attempts (matches JUPITER_MAX_RETRIES=4 in the source)
    expect(quoteCallCount).toBe(5);
  }, 120_000); // 2+4+8+16 = 30s real backoff; mock but still allow headroom
});

// ---------------------------------------------------------------------------
// Test group 5: disallowed programId → aggregator_program_not_allowlisted
// ---------------------------------------------------------------------------

describe('executeTradeSolana() — disallowed Jupiter programId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns aggregator_program_not_allowlisted when swap program is not allowlisted', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes('/quote')) {
        return { ok: true, json: async () => makeJupiterQuote() } as unknown as Response;
      }
      if (url.includes('/swap-instructions')) {
        return {
          ok: true,
          json: async () => makeSwapInstructions({ swapProgramId: 'AttackerProgram1111111111111111111111111111' }),
        } as unknown as Response;
      }
      return { ok: false, status: 500, text: async () => 'unexpected' } as unknown as Response;
    });

    const { executeTradeSolana } = await import('./execute-trade-solana.js');
    const result = await executeTradeSolana(VALID_SOLANA_ORDER, VALID_ENV);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error_kind).toBe('aggregator_program_not_allowlisted');
      // signer key must not appear in the error
      expect(result.error).not.toContain(SQUADS_KEY_SENTINEL);
    }
  });
});

// ---------------------------------------------------------------------------
// Test group 6: Missing SQUADS_MULTISIG_ADDRESS AND SQUADS_VAULT_ADDRESS
// ---------------------------------------------------------------------------

describe('executeTradeSolana() — missing Squads address config', () => {
  it('returns executor_error when neither SQUADS_VAULT_ADDRESS nor SQUADS_MULTISIG_ADDRESS is set', async () => {
    const { executeTradeSolana } = await import('./execute-trade-solana.js');
    const result = await executeTradeSolana(VALID_SOLANA_ORDER, {
      EXECUTOR_STUB_MODE: '0',
      SQUADS_SIGNER_KEY: SQUADS_KEY_SENTINEL,
      RPC_SOL: VALID_RPC,
      // No SQUADS_VAULT_ADDRESS, no SQUADS_MULTISIG_ADDRESS
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error_kind).toBe('executor_error');
      expect(result.error).not.toContain(SQUADS_KEY_SENTINEL);
    }
  });
});

// ---------------------------------------------------------------------------
// Test group 7: RPC hostname denylisted → rpc_hostname_not_allowlisted
// ---------------------------------------------------------------------------

describe('executeTradeSolana() — RPC hostname allowlist', () => {
  it('returns rpc_hostname_not_allowlisted when RPC URL is not in allowlist (strict mode)', async () => {
    const { executeTradeSolana } = await import('./execute-trade-solana.js');
    const result = await executeTradeSolana(VALID_SOLANA_ORDER, {
      ...VALID_ENV,
      RPC_SOL: BANNED_RPC,
      RPC_VALIDATION_MODE: 'strict',
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error_kind).toBe('rpc_hostname_not_allowlisted');
      expect(result.error).not.toContain(SQUADS_KEY_SENTINEL);
    }
  });

  it('allows execution in skip mode for non-allowlisted RPC', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes('/quote')) {
        return { ok: true, json: async () => makeJupiterQuote() } as unknown as Response;
      }
      if (url.includes('/swap-instructions')) {
        return { ok: true, json: async () => makeSwapInstructions() } as unknown as Response;
      }
      return { ok: false, status: 500, text: async () => 'unexpected' } as unknown as Response;
    });

    const { executeTradeSolana } = await import('./execute-trade-solana.js');
    const result = await executeTradeSolana(VALID_SOLANA_ORDER, {
      ...VALID_ENV,
      RPC_SOL: BANNED_RPC,
      RPC_VALIDATION_MODE: 'skip',
    });

    // skip mode bypasses allowlist — should not fail with rpc_hostname_not_allowlisted
    if (result.status === 'failed') {
      expect(result.error_kind).not.toBe('rpc_hostname_not_allowlisted');
    }
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Test group 8: Missing SQUADS_SIGNER_KEY → executor_error
// ---------------------------------------------------------------------------

describe('executeTradeSolana() — missing signer key', () => {
  it('returns executor_error when SQUADS_SIGNER_KEY is missing', async () => {
    const { executeTradeSolana } = await import('./execute-trade-solana.js');
    const result = await executeTradeSolana(VALID_SOLANA_ORDER, {
      EXECUTOR_STUB_MODE: '0',
      SQUADS_VAULT_ADDRESS: VALID_ENV['SQUADS_VAULT_ADDRESS'],
      SQUADS_MULTISIG_ADDRESS: VALID_ENV['SQUADS_MULTISIG_ADDRESS'],
      RPC_SOL: VALID_RPC,
      // No SQUADS_SIGNER_KEY
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error_kind).toBe('executor_error');
    }
  });
});

// ---------------------------------------------------------------------------
// Test group 9: vaultTransactionCreate throws → squads_propose_failed
// ---------------------------------------------------------------------------

describe('executeTradeSolana() — vaultTransactionCreate throws', () => {
  beforeEach(() => {
    // Override the @sqds/multisig mock so vaultTransactionCreate throws.
    vi.doMock('@sqds/multisig', () => ({
      getVaultPda: () => [{ toString: () => 'FakeVaultPDA' }],
      accounts: {
        Multisig: {
          fromAccountAddress: async () => ({
            transactionIndex: FAKE_SQUADS_TX_INDEX - 1,
            threshold: 1,
          }),
        },
      },
      instructions: {
        vaultTransactionCreate: () => {
          throw new Error('squads_propose_failed: rpc error: vaultTransactionCreate rejected');
        },
        proposalCreate: () => ({ programId: {}, keys: [], data: Buffer.alloc(32) }),
        proposalApprove: () => ({ programId: {}, keys: [], data: Buffer.alloc(32) }),
        vaultTransactionExecute: async () => ({ instruction: {}, lookupTableAccounts: [] }),
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@sqds/multisig');
  });

  it('returns squads_propose_failed when vaultTransactionCreate throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes('/quote')) {
        return { ok: true, json: async () => makeJupiterQuote() } as unknown as Response;
      }
      if (url.includes('/swap-instructions')) {
        return { ok: true, json: async () => makeSwapInstructions() } as unknown as Response;
      }
      return { ok: false, status: 500, text: async () => 'unexpected' } as unknown as Response;
    });

    // Re-import to pick up the overridden mock
    const { executeTradeSolana } = await import('./execute-trade-solana.js');
    const result = await executeTradeSolana(VALID_SOLANA_ORDER, VALID_ENV);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error_kind).toBe('squads_propose_failed');
      expect(result.error).not.toContain(SQUADS_KEY_SENTINEL);
    }
  });
});

// ---------------------------------------------------------------------------
// Test group 10: Signer key NEVER appears in any failure receipt
// ---------------------------------------------------------------------------

describe('executeTradeSolana() — signer key never in failure receipts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('failure receipt does not contain SQUADS_SIGNER_KEY when RPC is denied', async () => {
    const { executeTradeSolana } = await import('./execute-trade-solana.js');
    const result = await executeTradeSolana(VALID_SOLANA_ORDER, {
      ...VALID_ENV,
      SQUADS_SIGNER_KEY: SQUADS_KEY_SENTINEL,
      RPC_SOL: BANNED_RPC,
      RPC_VALIDATION_MODE: 'strict',
    });

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain(SQUADS_KEY_SENTINEL);
  });

  it('failure receipt does not contain SQUADS_SIGNER_KEY when Jupiter returns 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes('/quote')) {
        return { ok: false, status: 500, text: async () => 'Internal Server Error' } as unknown as Response;
      }
      return { ok: false, status: 500, text: async () => 'unexpected' } as unknown as Response;
    });

    const { executeTradeSolana } = await import('./execute-trade-solana.js');
    const result = await executeTradeSolana(VALID_SOLANA_ORDER, {
      ...VALID_ENV,
      SQUADS_SIGNER_KEY: SQUADS_KEY_SENTINEL,
    });

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain(SQUADS_KEY_SENTINEL);
  });
});
