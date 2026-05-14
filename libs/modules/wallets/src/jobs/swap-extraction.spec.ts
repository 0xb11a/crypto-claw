/**
 * Unit tests for swap-extraction.ts — pure functions extractEvmSwaps and
 * extractSolanaSwaps (SPEC §14, DoD §A, §I).
 *
 * All tests are table-driven and cover the complete legacy-parity contract
 * documented in swap-extraction.ts (bug-for-bug parity with
 * scripts/activity-wallets-bg.js).
 *
 * EVM swap cases:
 *   - stable → token (BUY): counterOut + subjectIn
 *   - token → stable (SELL): subjectOut + counterIn
 *   - wrappedNative → token (BUY via WETH)
 *   - token → wrappedNative (SELL via WETH)
 *   - Multi-hop: ins and outs both present but no identifiable direction → skip
 *   - Token → token (no stable/native leg) → skip
 *   - Single transfer (airdrop, no swap direction) → skip
 *   - Case-insensitive wallet address matching
 *   - Multiple swap txs in single call → two signals
 *   - Timestamp conversion: seconds → ISO-8601 string
 *
 * Solana swap cases:
 *   - SOL (wSOL) → token (BUY)
 *   - USDC → token (BUY via stablecoin)
 *   - token → USDC (SELL via stablecoin)
 *   - token → SOL (SELL via wSOL)
 *   - Non-SWAP type → skip
 *   - Multi-hop: ins + outs but no identifiable direction → skip
 *   - Symbol resolution: tokenSymbol > tokenName > mint prefix
 *   - tx.timestamp=0 handling
 *
 * Byte-identical parity claim:
 *   This file includes a hand-crafted fixture that was manually verified
 *   against the legacy extractEvmSwaps / extractSolanaSwaps from
 *   scripts/activity-wallets-bg.js by tracing the algorithm field-by-field.
 *   See comment in the "Parity claim" block below.
 *
 * SPEC §8: no I/O, no DI — pure functions only.
 * DoD §I: bug-for-bug parity with legacy scripts/activity-wallets-bg.js.
 */

import { describe, it, expect } from 'vitest';
import { extractEvmSwaps, extractSolanaSwaps } from './swap-extraction.js';
import type { CreateSignalInput } from './swap-extraction.js';
import type { EvmTokenTxRow } from '@cclaw/adapters-evm-explorer';
import type { HeliusTransaction } from '@cclaw/adapters-helius';

// ---------------------------------------------------------------------------
// Shared test data / helpers
// ---------------------------------------------------------------------------

const WALLET = '0xWallet1111111111111111111111111111111111';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const TOKEN_A = '0xTokenA000000000000000000000000000000000';
const TOKEN_B = '0xTokenB000000000000000000000000000000000';

const BASE_STABLES = new Set([USDC_BASE]);

function makeEvmTransfer(overrides: Partial<EvmTokenTxRow>): EvmTokenTxRow {
  return {
    hash: '0xhash1',
    from: '0xOther',
    to: '0xOther',
    contractAddress: TOKEN_A,
    tokenSymbol: 'TKNA',
    tokenName: 'TokenA',
    value: '1000000',
    timeStamp: '1700000000',
    ...overrides,
  };
}

// Solana constants
const WALLET_SOL = 'WalletSolana111111111111111111111111111111';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_SOL = 'SolTokenMint111111111111111111111111111111';

const SOLANA_STABLES = new Set([USDC_SOL]);

function makeSolanaTx(overrides: Partial<HeliusTransaction>): HeliusTransaction {
  return {
    signature: 'txSig111',
    timestamp: 1700000000,
    type: 'SWAP',
    tokenTransfers: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EVM: extractEvmSwaps
// ---------------------------------------------------------------------------

describe('extractEvmSwaps — EVM swap extraction', () => {
  // -------------------------------------------------------------------------
  // BUY: stable → token (counterOut + subjectIn)
  // -------------------------------------------------------------------------

  describe('BUY: stable → token', () => {
    it('emits one buy signal when wallet sends stable and receives token', () => {
      const txs: EvmTokenTxRow[] = [
        // Wallet sends USDC (counter out)
        makeEvmTransfer({
          hash: '0xbuy1',
          from: WALLET,
          to: '0xDEX',
          contractAddress: USDC_BASE,
          tokenSymbol: 'USDC',
          value: '1000000',
        }),
        // Wallet receives TOKEN_A (subject in)
        makeEvmTransfer({
          hash: '0xbuy1',
          from: '0xDEX',
          to: WALLET,
          contractAddress: TOKEN_A,
          tokenSymbol: 'TKNA',
          value: '500000',
        }),
      ];

      const result = extractEvmSwaps(txs, WALLET, BASE_STABLES);

      expect(result).toHaveLength(1);
      expect(result[0]!.action).toBe('buy');
      expect(result[0]!.tx_hash).toBe('0xbuy1');
      expect(result[0]!.token_address).toBe(TOKEN_A);
      expect(result[0]!.token_symbol).toBe('TKNA');
      expect(result[0]!.counter_token_address).toBe(USDC_BASE);
      expect(result[0]!.counter_token_symbol).toBe('USDC');
      expect(result[0]!.amount_token).toBe('500000');
    });

    it('tx_timestamp is ISO-8601 from timeStamp seconds (1700000000 → 2023-11-14T...)', () => {
      const txs: EvmTokenTxRow[] = [
        makeEvmTransfer({
          hash: '0xts1',
          from: WALLET,
          to: '0xDEX',
          contractAddress: USDC_BASE,
          tokenSymbol: 'USDC',
          timeStamp: '1700000000',
        }),
        makeEvmTransfer({
          hash: '0xts1',
          from: '0xDEX',
          to: WALLET,
          contractAddress: TOKEN_A,
          tokenSymbol: 'TKNA',
          timeStamp: '1700000000',
        }),
      ];

      const result = extractEvmSwaps(txs, WALLET, BASE_STABLES);

      expect(result).toHaveLength(1);
      // ISO format of Unix 1700000000 s
      const expected = new Date(1700000000 * 1000).toISOString();
      expect(result[0]!.tx_timestamp).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // SELL: token → stable (subjectOut + counterIn)
  // -------------------------------------------------------------------------

  describe('SELL: token → stable', () => {
    it('emits one sell signal when wallet sends token and receives stable', () => {
      const txs: EvmTokenTxRow[] = [
        // Wallet sends TOKEN_A (subject out)
        makeEvmTransfer({
          hash: '0xsell1',
          from: WALLET,
          to: '0xDEX',
          contractAddress: TOKEN_A,
          tokenSymbol: 'TKNA',
          value: '500000',
        }),
        // Wallet receives USDC (counter in)
        makeEvmTransfer({
          hash: '0xsell1',
          from: '0xDEX',
          to: WALLET,
          contractAddress: USDC_BASE,
          tokenSymbol: 'USDC',
          value: '1000000',
        }),
      ];

      const result = extractEvmSwaps(txs, WALLET, BASE_STABLES);

      expect(result).toHaveLength(1);
      expect(result[0]!.action).toBe('sell');
      expect(result[0]!.token_address).toBe(TOKEN_A);
      expect(result[0]!.counter_token_address).toBe(USDC_BASE);
    });
  });

  // -------------------------------------------------------------------------
  // BUY via WETH (wrappedNative)
  // -------------------------------------------------------------------------

  describe('BUY via wrappedNative (WETH → token)', () => {
    it('emits one buy signal when wallet sends WETH and receives token', () => {
      const txs: EvmTokenTxRow[] = [
        makeEvmTransfer({
          hash: '0xweth1',
          from: WALLET,
          to: '0xDEX',
          contractAddress: WETH_BASE,
          tokenSymbol: 'WETH',
          value: '1000000000000000000',
        }),
        makeEvmTransfer({
          hash: '0xweth1',
          from: '0xDEX',
          to: WALLET,
          contractAddress: TOKEN_A,
          tokenSymbol: 'TKNA',
          value: '999',
        }),
      ];
      const stablesWithWeth = new Set([USDC_BASE]); // WETH not in stables; passed as wrappedNative

      const result = extractEvmSwaps(txs, WALLET, stablesWithWeth, WETH_BASE);

      expect(result).toHaveLength(1);
      expect(result[0]!.action).toBe('buy');
      expect(result[0]!.counter_token_address).toBe(WETH_BASE);
    });
  });

  // -------------------------------------------------------------------------
  // SELL via WETH (token → wrappedNative)
  // -------------------------------------------------------------------------

  describe('SELL via wrappedNative (token → WETH)', () => {
    it('emits one sell signal when wallet sends token and receives WETH', () => {
      const txs: EvmTokenTxRow[] = [
        makeEvmTransfer({
          hash: '0xweth2',
          from: WALLET,
          to: '0xDEX',
          contractAddress: TOKEN_A,
          tokenSymbol: 'TKNA',
          value: '999',
        }),
        makeEvmTransfer({
          hash: '0xweth2',
          from: '0xDEX',
          to: WALLET,
          contractAddress: WETH_BASE,
          tokenSymbol: 'WETH',
          value: '1000000000000000000',
        }),
      ];

      const result = extractEvmSwaps(txs, WALLET, BASE_STABLES, WETH_BASE);

      expect(result).toHaveLength(1);
      expect(result[0]!.action).toBe('sell');
      expect(result[0]!.counter_token_address).toBe(WETH_BASE);
    });
  });

  // -------------------------------------------------------------------------
  // Skipped: no stable/native leg (token → token)
  // -------------------------------------------------------------------------

  describe('SKIP: token → token (no stable/native leg)', () => {
    it('emits no signal when both sides are non-stable tokens', () => {
      const txs: EvmTokenTxRow[] = [
        makeEvmTransfer({
          hash: '0xswap1',
          from: WALLET,
          to: '0xDEX',
          contractAddress: TOKEN_A,
          tokenSymbol: 'A',
          value: '100',
        }),
        makeEvmTransfer({
          hash: '0xswap1',
          from: '0xDEX',
          to: WALLET,
          contractAddress: TOKEN_B,
          tokenSymbol: 'B',
          value: '200',
        }),
      ];

      const result = extractEvmSwaps(txs, WALLET, BASE_STABLES);

      expect(result).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Skipped: single-transfer (airdrop — no swap direction)
  // -------------------------------------------------------------------------

  describe('SKIP: single transfer (airdrop)', () => {
    it('emits no signal for a single incoming transfer (no outs)', () => {
      const txs: EvmTokenTxRow[] = [
        makeEvmTransfer({
          hash: '0xairdrop1',
          from: '0xAirdropper',
          to: WALLET,
          contractAddress: TOKEN_A,
          tokenSymbol: 'TKNA',
        }),
      ];

      const result = extractEvmSwaps(txs, WALLET, BASE_STABLES);

      expect(result).toHaveLength(0);
    });

    it('emits no signal for a single outgoing transfer (no ins)', () => {
      const txs: EvmTokenTxRow[] = [
        makeEvmTransfer({
          hash: '0xsend1',
          from: WALLET,
          to: '0xRecipient',
          contractAddress: TOKEN_A,
          tokenSymbol: 'TKNA',
        }),
      ];

      const result = extractEvmSwaps(txs, WALLET, BASE_STABLES);

      expect(result).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple transactions → two signals
  // -------------------------------------------------------------------------

  describe('Multiple swap transactions → multiple signals', () => {
    it('emits one signal per swap group when there are two different tx_hashes', () => {
      const txs: EvmTokenTxRow[] = [
        // Swap 1: BUY
        makeEvmTransfer({
          hash: '0xtx1',
          from: WALLET,
          to: '0xDEX',
          contractAddress: USDC_BASE,
          tokenSymbol: 'USDC',
          value: '100',
        }),
        makeEvmTransfer({
          hash: '0xtx1',
          from: '0xDEX',
          to: WALLET,
          contractAddress: TOKEN_A,
          tokenSymbol: 'A',
          value: '200',
        }),
        // Swap 2: SELL
        makeEvmTransfer({
          hash: '0xtx2',
          from: WALLET,
          to: '0xDEX',
          contractAddress: TOKEN_B,
          tokenSymbol: 'B',
          value: '300',
        }),
        makeEvmTransfer({
          hash: '0xtx2',
          from: '0xDEX',
          to: WALLET,
          contractAddress: USDC_BASE,
          tokenSymbol: 'USDC',
          value: '400',
        }),
      ];

      const result = extractEvmSwaps(txs, WALLET, BASE_STABLES);

      expect(result).toHaveLength(2);
      const buy = result.find((r) => r.action === 'buy');
      const sell = result.find((r) => r.action === 'sell');
      expect(buy).toBeDefined();
      expect(sell).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Case-insensitive wallet matching
  // -------------------------------------------------------------------------

  describe('Case-insensitive wallet address matching', () => {
    it('matches wallet address case-insensitively', () => {
      const WALLET_UPPER = WALLET.toUpperCase();
      const txs: EvmTokenTxRow[] = [
        // from/to are uppercase version of wallet
        makeEvmTransfer({
          hash: '0xcasetest',
          from: WALLET_UPPER,
          to: '0xDEX',
          contractAddress: USDC_BASE,
          tokenSymbol: 'USDC',
          value: '100',
        }),
        makeEvmTransfer({
          hash: '0xcasetest',
          from: '0xDEX',
          to: WALLET_UPPER,
          contractAddress: TOKEN_A,
          tokenSymbol: 'A',
          value: '200',
        }),
      ];

      // Call with lowercase wallet (the canonical caller form)
      const result = extractEvmSwaps(txs, WALLET.toLowerCase(), BASE_STABLES);

      expect(result).toHaveLength(1);
      expect(result[0]!.action).toBe('buy');
    });
  });

  // -------------------------------------------------------------------------
  // Empty input → empty output
  // -------------------------------------------------------------------------

  describe('Empty input', () => {
    it('returns [] when txs is empty', () => {
      const result = extractEvmSwaps([], WALLET, BASE_STABLES);
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Parity claim: byte-identical output for a hand-crafted fixture
  //
  // We trace the legacy algorithm manually:
  //   1. Group by hash → one group for '0xparityhash'
  //   2. ins = [{ to: WALLET, contractAddress: TOKEN_A }]
  //   3. outs = [{ from: WALLET, contractAddress: USDC_BASE }]
  //   4. counterIn = undefined (USDC not in ins); counterOut = outs[0] (USDC in outs)
  //   5. subjectIn = ins[0] (TOKEN_A not in stables); subjectOut = undefined
  //   6. counterOut && subjectIn → BUY
  //   7. Output:
  //      tx_hash: '0xparityhash'
  //      action: 'buy'
  //      token_address: TOKEN_A (subject = subjectIn)
  //      token_symbol: 'TKNA' (subject.tokenSymbol)
  //      counter_token_address: USDC_BASE (counter = counterOut)
  //      counter_token_symbol: 'USDC' (counter.tokenSymbol)
  //      amount_token: '888' (subject.value)
  //      tx_timestamp: new Date(1700100000 * 1000).toISOString()
  //
  // Legacy uses subject.tokenSymbol directly (returns undefined when absent),
  // but typed code uses ?? null (returns null when absent). This is documented
  // as CONCERN-1 in the handoff. For this fixture both are present so the
  // parity holds for the non-null case.
  // -------------------------------------------------------------------------

  describe('Parity claim: hand-crafted fixture matches legacy algorithm', () => {
    it('produces byte-identical output for the parity fixture (non-null symbols)', () => {
      const txs: EvmTokenTxRow[] = [
        {
          hash: '0xparityhash',
          from: WALLET,
          to: '0xDEX',
          contractAddress: USDC_BASE,
          tokenSymbol: 'USDC',
          tokenName: 'USD Coin',
          value: '1000000',
          timeStamp: '1700100000',
        },
        {
          hash: '0xparityhash',
          from: '0xDEX',
          to: WALLET,
          contractAddress: TOKEN_A,
          tokenSymbol: 'TKNA',
          tokenName: 'TokenA',
          value: '888',
          timeStamp: '1700100000',
        },
      ];

      const expected: CreateSignalInput = {
        tx_hash: '0xparityhash',
        action: 'buy',
        token_address: TOKEN_A,
        token_symbol: 'TKNA',
        counter_token_address: USDC_BASE,
        counter_token_symbol: 'USDC',
        amount_token: '888',
        tx_timestamp: new Date(1700100000 * 1000).toISOString(),
      };

      const result = extractEvmSwaps(txs, WALLET, BASE_STABLES);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expected);
    });
  });

  // -------------------------------------------------------------------------
  // tokenSymbol null (absence) — note the divergence from legacy
  // -------------------------------------------------------------------------

  describe('tokenSymbol absent — ?? null vs legacy undefined (CONCERN-1)', () => {
    it('returns token_symbol=null when tokenSymbol is missing from EvmTokenTxRow', () => {
      // TypeScript type has tokenSymbol as string (required), but we test the
      // path where it might be absent at runtime (API drift).
      // New code: `subject.tokenSymbol ?? null` → null
      // Legacy code: `subject.tokenSymbol` → undefined (no ?? null)
      // This divergence is filed as CONCERN-1 in the handoff.
      const txs: EvmTokenTxRow[] = [
        {
          hash: '0xnosym',
          from: WALLET,
          to: '0xDEX',
          contractAddress: USDC_BASE,
          tokenSymbol: undefined as unknown as string,
          tokenName: 'USDC',
          value: '10',
          timeStamp: '1700000000',
        },
        {
          hash: '0xnosym',
          from: '0xDEX',
          to: WALLET,
          contractAddress: TOKEN_A,
          tokenSymbol: undefined as unknown as string,
          tokenName: 'TokenA',
          value: '20',
          timeStamp: '1700000000',
        },
      ];

      const result = extractEvmSwaps(txs, WALLET, BASE_STABLES);

      expect(result).toHaveLength(1);
      // New code returns null (not undefined)
      expect(result[0]!.token_symbol).toBeNull();
      expect(result[0]!.counter_token_symbol).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Solana: extractSolanaSwaps
// ---------------------------------------------------------------------------

describe('extractSolanaSwaps — Solana swap extraction', () => {
  // -------------------------------------------------------------------------
  // BUY: wSOL → token
  // -------------------------------------------------------------------------

  describe('BUY: wSOL → token', () => {
    it('emits one buy signal when wallet receives token and sends wSOL', () => {
      const tx = makeSolanaTx({
        signature: 'sig_wsol_buy',
        timestamp: 1700000000,
        type: 'SWAP',
        tokenTransfers: [
          // wallet sends wSOL (counter out)
          {
            mint: WSOL,
            tokenSymbol: 'SOL',
            tokenName: 'Wrapped SOL',
            fromUserAccount: WALLET_SOL,
            toUserAccount: '0xDEX',
            tokenAmount: '1000000000',
          },
          // wallet receives TOKEN_SOL (subject in)
          {
            mint: TOKEN_SOL,
            tokenSymbol: 'TMINT',
            tokenName: null,
            fromUserAccount: '0xDEX',
            toUserAccount: WALLET_SOL,
            tokenAmount: '500',
          },
        ],
      });

      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);

      expect(result).toHaveLength(1);
      expect(result[0]!.action).toBe('buy');
      expect(result[0]!.tx_hash).toBe('sig_wsol_buy');
      expect(result[0]!.token_address).toBe(TOKEN_SOL);
      expect(result[0]!.counter_token_address).toBe(WSOL);
      expect(result[0]!.amount_token).toBe('500');
    });
  });

  // -------------------------------------------------------------------------
  // BUY: USDC → token
  // -------------------------------------------------------------------------

  describe('BUY: USDC → token', () => {
    it('emits one buy signal when wallet receives token and sends USDC', () => {
      const tx = makeSolanaTx({
        signature: 'sig_usdc_buy',
        tokenTransfers: [
          {
            mint: USDC_SOL,
            tokenSymbol: 'USDC',
            tokenName: 'USD Coin',
            fromUserAccount: WALLET_SOL,
            toUserAccount: '0xDEX',
            tokenAmount: '100000000',
          },
          {
            mint: TOKEN_SOL,
            tokenSymbol: 'TMINT',
            tokenName: null,
            fromUserAccount: '0xDEX',
            toUserAccount: WALLET_SOL,
            tokenAmount: '999',
          },
        ],
      });

      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);

      expect(result).toHaveLength(1);
      expect(result[0]!.action).toBe('buy');
      expect(result[0]!.counter_token_address).toBe(USDC_SOL);
    });
  });

  // -------------------------------------------------------------------------
  // SELL: token → USDC
  // -------------------------------------------------------------------------

  describe('SELL: token → USDC', () => {
    it('emits one sell signal when wallet sends token and receives USDC', () => {
      const tx = makeSolanaTx({
        signature: 'sig_sell_usdc',
        tokenTransfers: [
          {
            mint: TOKEN_SOL,
            tokenSymbol: 'TMINT',
            tokenName: null,
            fromUserAccount: WALLET_SOL,
            toUserAccount: '0xDEX',
            tokenAmount: '999',
          },
          {
            mint: USDC_SOL,
            tokenSymbol: 'USDC',
            tokenName: 'USD Coin',
            fromUserAccount: '0xDEX',
            toUserAccount: WALLET_SOL,
            tokenAmount: '100000000',
          },
        ],
      });

      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);

      expect(result).toHaveLength(1);
      expect(result[0]!.action).toBe('sell');
      expect(result[0]!.token_address).toBe(TOKEN_SOL);
      expect(result[0]!.counter_token_address).toBe(USDC_SOL);
    });
  });

  // -------------------------------------------------------------------------
  // SELL: token → wSOL
  // -------------------------------------------------------------------------

  describe('SELL: token → wSOL', () => {
    it('emits one sell signal when wallet sends token and receives wSOL', () => {
      const tx = makeSolanaTx({
        signature: 'sig_sell_wsol',
        tokenTransfers: [
          {
            mint: TOKEN_SOL,
            tokenSymbol: 'TMINT',
            tokenName: null,
            fromUserAccount: WALLET_SOL,
            toUserAccount: '0xDEX',
            tokenAmount: '500',
          },
          {
            mint: WSOL,
            tokenSymbol: 'SOL',
            tokenName: 'Wrapped SOL',
            fromUserAccount: '0xDEX',
            toUserAccount: WALLET_SOL,
            tokenAmount: '1000000000',
          },
        ],
      });

      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);

      expect(result).toHaveLength(1);
      expect(result[0]!.action).toBe('sell');
      expect(result[0]!.counter_token_address).toBe(WSOL);
    });
  });

  // -------------------------------------------------------------------------
  // SKIP: non-SWAP type
  // -------------------------------------------------------------------------

  describe('SKIP: type !== SWAP', () => {
    it('emits no signal for a TRANSFER type transaction', () => {
      const tx = makeSolanaTx({
        type: 'TRANSFER',
        tokenTransfers: [
          {
            mint: TOKEN_SOL,
            tokenSymbol: 'T',
            tokenName: null,
            fromUserAccount: WALLET_SOL,
            toUserAccount: '0xOther',
            tokenAmount: '1',
          },
          {
            mint: USDC_SOL,
            tokenSymbol: 'USDC',
            tokenName: null,
            fromUserAccount: '0xOther',
            toUserAccount: WALLET_SOL,
            tokenAmount: '1',
          },
        ],
      });

      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);
      expect(result).toHaveLength(0);
    });

    it('emits no signal for an UNKNOWN type transaction', () => {
      const tx = makeSolanaTx({ type: 'UNKNOWN' });
      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);
      expect(result).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // SKIP: multi-hop (no identifiable stable direction)
  // -------------------------------------------------------------------------

  describe('SKIP: multi-hop (no stable/native leg)', () => {
    it('emits no signal when both legs are non-stable tokens', () => {
      const TOKEN_OTHER = 'OtherTokenMint11111111111111111111111111';
      const tx = makeSolanaTx({
        tokenTransfers: [
          {
            mint: TOKEN_SOL,
            tokenSymbol: 'A',
            tokenName: null,
            fromUserAccount: WALLET_SOL,
            toUserAccount: '0xDEX',
            tokenAmount: '100',
          },
          {
            mint: TOKEN_OTHER,
            tokenSymbol: 'B',
            tokenName: null,
            fromUserAccount: '0xDEX',
            toUserAccount: WALLET_SOL,
            tokenAmount: '200',
          },
        ],
      });

      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);
      expect(result).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Symbol resolution: tokenSymbol > tokenName > mint prefix (legacy parity)
  // -------------------------------------------------------------------------

  describe('Symbol resolution (symFor — legacy parity)', () => {
    it('uses tokenSymbol when present', () => {
      const tx = makeSolanaTx({
        tokenTransfers: [
          {
            mint: WSOL,
            tokenSymbol: 'SOL',
            tokenName: 'Wrapped SOL',
            fromUserAccount: WALLET_SOL,
            toUserAccount: '0xDEX',
            tokenAmount: '1',
          },
          {
            mint: TOKEN_SOL,
            tokenSymbol: 'MYTOKEN',
            tokenName: 'My Token Full Name',
            fromUserAccount: '0xDEX',
            toUserAccount: WALLET_SOL,
            tokenAmount: '1',
          },
        ],
      });

      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);

      expect(result[0]!.token_symbol).toBe('MYTOKEN');
      expect(result[0]!.counter_token_symbol).toBe('SOL');
    });

    it('falls back to tokenName when tokenSymbol is absent', () => {
      const tx = makeSolanaTx({
        tokenTransfers: [
          {
            mint: WSOL,
            tokenSymbol: undefined as unknown as string,
            tokenName: 'Wrapped SOL',
            fromUserAccount: WALLET_SOL,
            toUserAccount: '0xDEX',
            tokenAmount: '1',
          },
          {
            mint: TOKEN_SOL,
            tokenSymbol: undefined as unknown as string,
            tokenName: 'My Token Full Name',
            fromUserAccount: '0xDEX',
            toUserAccount: WALLET_SOL,
            tokenAmount: '1',
          },
        ],
      });

      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);

      expect(result[0]!.token_symbol).toBe('My Token Full Name');
      expect(result[0]!.counter_token_symbol).toBe('Wrapped SOL');
    });

    it('falls back to first 8 chars of mint when both tokenSymbol and tokenName absent', () => {
      const tx = makeSolanaTx({
        tokenTransfers: [
          {
            mint: WSOL,
            tokenSymbol: undefined as unknown as string,
            tokenName: undefined as unknown as string,
            fromUserAccount: WALLET_SOL,
            toUserAccount: '0xDEX',
            tokenAmount: '1',
          },
          {
            mint: TOKEN_SOL,
            tokenSymbol: undefined as unknown as string,
            tokenName: undefined as unknown as string,
            fromUserAccount: '0xDEX',
            toUserAccount: WALLET_SOL,
            tokenAmount: '1',
          },
        ],
      });

      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);

      expect(result[0]!.token_symbol).toBe(TOKEN_SOL.slice(0, 8));
    });
  });

  // -------------------------------------------------------------------------
  // tx.timestamp handling
  // -------------------------------------------------------------------------

  describe('tx.timestamp conversion', () => {
    it('tx_timestamp is ISO-8601 from timestamp seconds', () => {
      const tx = makeSolanaTx({
        timestamp: 1700000000,
        tokenTransfers: [
          {
            mint: WSOL,
            tokenSymbol: 'SOL',
            tokenName: null,
            fromUserAccount: WALLET_SOL,
            toUserAccount: '0xDEX',
            tokenAmount: '1',
          },
          {
            mint: TOKEN_SOL,
            tokenSymbol: 'T',
            tokenName: null,
            fromUserAccount: '0xDEX',
            toUserAccount: WALLET_SOL,
            tokenAmount: '1',
          },
        ],
      });

      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);

      const expected = new Date(1700000000 * 1000).toISOString();
      expect(result[0]!.tx_timestamp).toBe(expected);
    });

    it('handles tx.timestamp=0 (genesis block edge case) → 1970-01-01T00:00:00.000Z', () => {
      const tx = makeSolanaTx({
        timestamp: 0,
        tokenTransfers: [
          {
            mint: WSOL,
            tokenSymbol: 'SOL',
            tokenName: null,
            fromUserAccount: WALLET_SOL,
            toUserAccount: '0xDEX',
            tokenAmount: '1',
          },
          {
            mint: TOKEN_SOL,
            tokenSymbol: 'T',
            tokenName: null,
            fromUserAccount: '0xDEX',
            toUserAccount: WALLET_SOL,
            tokenAmount: '1',
          },
        ],
      });

      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);

      expect(result[0]!.tx_timestamp).toBe('1970-01-01T00:00:00.000Z');
    });

    it('handles missing timestamp field (undefined) → 1970-01-01T00:00:00.000Z', () => {
      const tx = {
        signature: 'sig',
        timestamp: undefined as unknown as number,
        type: 'SWAP',
        tokenTransfers: [
          {
            mint: WSOL,
            tokenSymbol: 'SOL',
            tokenName: null,
            fromUserAccount: WALLET_SOL,
            toUserAccount: '0xDEX',
            tokenAmount: '1',
          },
          {
            mint: TOKEN_SOL,
            tokenSymbol: 'T',
            tokenName: null,
            fromUserAccount: '0xDEX',
            toUserAccount: WALLET_SOL,
            tokenAmount: '1',
          },
        ],
      };

      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);
      // (tx.timestamp ?? 0) → 0 → 1970-01-01T00:00:00.000Z
      expect(result[0]!.tx_timestamp).toBe('1970-01-01T00:00:00.000Z');
    });
  });

  // -------------------------------------------------------------------------
  // SKIP: empty tokenTransfers
  // -------------------------------------------------------------------------

  describe('SKIP: no tokenTransfers', () => {
    it('emits no signal when tokenTransfers is empty', () => {
      const tx = makeSolanaTx({ tokenTransfers: [] });
      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);
      expect(result).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Empty input
  // -------------------------------------------------------------------------

  describe('Empty input', () => {
    it('returns [] when txs is empty', () => {
      const result = extractSolanaSwaps([], WALLET_SOL, SOLANA_STABLES, WSOL);
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Parity claim: byte-identical output for a hand-crafted Solana fixture
  //
  // Legacy trace (extractSolanaSwaps in scripts/activity-wallets-bg.js):
  //   tx.type === 'SWAP' → proceed
  //   ins = [{toUserAccount === WALLET_SOL, mint: TOKEN_SOL}]
  //   outs = [{fromUserAccount === WALLET_SOL, mint: WSOL}]
  //   counterOut = outs[0] (WSOL is wrappedNative) → BUY
  //   subjectIn = ins[0] (TOKEN_SOL is not counter)
  //   action = 'buy', subject = ins[0], counter = outs[0]
  //   symFor(subject) = 'TMINT' (tokenSymbol present)
  //   symFor(counter) = 'SOL'   (tokenSymbol present)
  //   amount_token = String(subject.tokenAmount ?? '') = '777'
  //   tx_timestamp = new Date(1700200000 * 1000).toISOString()
  // -------------------------------------------------------------------------

  describe('Parity claim: hand-crafted Solana fixture matches legacy algorithm', () => {
    it('produces byte-identical output for the Solana parity fixture', () => {
      const tx = makeSolanaTx({
        signature: 'sigParitySolana',
        timestamp: 1700200000,
        type: 'SWAP',
        tokenTransfers: [
          {
            mint: WSOL,
            tokenSymbol: 'SOL',
            tokenName: 'Wrapped SOL',
            fromUserAccount: WALLET_SOL,
            toUserAccount: '0xDEX',
            tokenAmount: 1000000000,
          },
          {
            mint: TOKEN_SOL,
            tokenSymbol: 'TMINT',
            tokenName: 'Token Mint',
            fromUserAccount: '0xDEX',
            toUserAccount: WALLET_SOL,
            tokenAmount: 777,
          },
        ],
      });

      const expected: CreateSignalInput = {
        tx_hash: 'sigParitySolana',
        action: 'buy',
        token_address: TOKEN_SOL,
        token_symbol: 'TMINT',
        counter_token_address: WSOL,
        counter_token_symbol: 'SOL',
        amount_token: '777',
        tx_timestamp: new Date(1700200000 * 1000).toISOString(),
      };

      const result = extractSolanaSwaps([tx], WALLET_SOL, SOLANA_STABLES, WSOL);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expected);
    });
  });
});
