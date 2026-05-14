/**
 * swap-extraction.ts — Pure functions for extracting swap signals from raw
 * on-chain transaction data.
 *
 * These functions are pure (no I/O, no side effects, no DI) so they can be
 * unit-tested without a NestJS container. They are imported by
 * ActivityWalletsProcessor and have **bug-for-bug parity** with the legacy
 * `scripts/activity-wallets-bg.js` `extractEvmSwaps` and `extractSolanaSwaps`
 * functions (DoD §I).
 *
 * Key parity notes:
 * - EVM: transfers are grouped by `tx_hash`; a swap is one counter leg + one
 *   subject leg (each side). Multi-hop (multiple OUTs, one IN) is SKIPPED.
 * - Solana: only `type === 'SWAP'` transactions are processed.
 * - Multi-hop skipped: if `ins.length === 0 || outs.length === 0`, the tx is
 *   skipped (both sides must be non-empty). The legacy code does NOT check
 *   for multi-hop explicitly (>1 counter or >1 subject); it uses `find`
 *   (returns the first match only) and `continue` when neither of the two
 *   swap directions can be identified. This behaviour is preserved here.
 */
import type { EvmTokenTxRow } from '@cclaw/adapters-evm-explorer';
import type { HeliusTransaction } from '@cclaw/adapters-helius';

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

/**
 * A single swap signal ready to be persisted to `smart_money_signals`.
 *
 * Field names mirror the INSERT columns in `scripts/activity-wallets-bg.js`
 * (legacy parity — DoD §I).
 */
export interface CreateSignalInput {
  /** Transaction hash (Etherscan `hash` or Helius `signature`). */
  tx_hash: string;
  /** 'buy' | 'sell' from the wallet's perspective. */
  action: 'buy' | 'sell';
  /** ERC-20 / SPL token address of the subject (non-counter) leg. */
  token_address: string;
  /** Symbol of the subject token (may be null if not available). */
  token_symbol: string | null;
  /** ERC-20 / SPL token address of the counter (stable/wrapped-native) leg. */
  counter_token_address: string | null;
  /** Symbol of the counter token. */
  counter_token_symbol: string | null;
  /** Transfer amount of the subject token (raw value string from the API). */
  amount_token: string;
  /** ISO-8601 timestamp of the transaction. */
  tx_timestamp: string;
}

// ---------------------------------------------------------------------------
// EVM swap extraction
// ---------------------------------------------------------------------------

/**
 * Extract swap signals from a list of ERC-20 token transfer rows.
 *
 * Algorithm (mirrors `scripts/activity-wallets-bg.js:extractEvmSwaps`):
 * 1. Group transfers by `tx_hash`.
 * 2. For each tx group, split into `ins` (to=wallet) and `outs` (from=wallet).
 *    Skip if either side is empty (no swap).
 * 3. Find the counter leg (stable/wrapped-native) and subject leg (any other token).
 *    - `counterOut + subjectIn` → buy
 *    - `subjectOut + counterIn` → sell
 *    Skip if neither direction is identifiable.
 * 4. Emit one signal per identifiable swap.
 *
 * Chain-specific stablecoin/wrapped-native sets are passed by the caller so
 * this function remains pure (no config/DI access required).
 *
 * @param txs - Raw ERC-20 token transfer rows from Etherscan `tokentx`.
 * @param walletAddress - The wallet address being analysed (case-insensitive for EVM).
 * @param stables - Set of lowercase stablecoin contract addresses for this chain.
 * @param wrappedNative - Lowercase wrapped native token address (e.g. WETH), or undefined.
 */
export function extractEvmSwaps(
  txs: EvmTokenTxRow[],
  walletAddress: string,
  stables: ReadonlySet<string>,
  wrappedNative?: string,
): CreateSignalInput[] {
  const wallet = walletAddress.toLowerCase();
  const wnative = wrappedNative?.toLowerCase();

  const isCounter = (addr: string): boolean => {
    const a = addr.toLowerCase();
    return stables.has(a) || (wnative !== undefined && a === wnative);
  };

  // 1. Group by tx_hash (mirrors legacy `byTx` Map)
  const byTx = new Map<string, EvmTokenTxRow[]>();
  for (const t of txs) {
    if (!byTx.has(t.hash)) byTx.set(t.hash, []);
    byTx.get(t.hash)!.push(t);
  }

  const swaps: CreateSignalInput[] = [];

  for (const [txHash, group] of byTx) {
    // 2. Split into ins and outs
    const ins = group.filter((t) => t.to.toLowerCase() === wallet);
    const outs = group.filter((t) => t.from.toLowerCase() === wallet);
    if (ins.length === 0 || outs.length === 0) continue;

    // 3. Identify swap direction (legacy uses `find` — first match only)
    const counterIn = ins.find((t) => isCounter(t.contractAddress));
    const counterOut = outs.find((t) => isCounter(t.contractAddress));
    const subjectIn = ins.find((t) => !isCounter(t.contractAddress));
    const subjectOut = outs.find((t) => !isCounter(t.contractAddress));

    let action: 'buy' | 'sell';
    let subject: EvmTokenTxRow;
    let counter: EvmTokenTxRow;

    if (counterOut && subjectIn) {
      action = 'buy';
      subject = subjectIn;
      counter = counterOut;
    } else if (subjectOut && counterIn) {
      action = 'sell';
      subject = subjectOut;
      counter = counterIn;
    } else {
      continue; // not a stable/native ↔ token swap (mirrors legacy `continue`)
    }

    swaps.push({
      tx_hash: txHash,
      action,
      token_address: subject.contractAddress,
      token_symbol: subject.tokenSymbol ?? null,
      counter_token_address: counter.contractAddress,
      counter_token_symbol: counter.tokenSymbol ?? null,
      amount_token: subject.value,
      tx_timestamp: new Date(parseInt(subject.timeStamp, 10) * 1000).toISOString(),
    });
  }

  return swaps;
}

// ---------------------------------------------------------------------------
// Solana swap extraction
// ---------------------------------------------------------------------------

/**
 * Extract swap signals from Helius parsed transaction objects.
 *
 * Algorithm (mirrors `scripts/activity-wallets-bg.js:extractSolanaSwaps`):
 * 1. Only process transactions where `type === 'SWAP'`.
 * 2. For each tx, split `tokenTransfers` into `ins` (toUserAccount=wallet)
 *    and `outs` (fromUserAccount=wallet).
 *    Skip if either side is empty.
 * 3. Identify counter/subject legs using the chain's stablecoin and wSOL set.
 * 4. Emit one signal per identifiable swap.
 *
 * Note: `tx.timestamp` is seconds; ISO conversion matches legacy exactly.
 *
 * @param txs - Parsed transactions from Helius.
 * @param walletAddress - The wallet address (base58; case-sensitive for Solana).
 * @param stables - Set of SPL token mint addresses for stablecoins on this chain.
 * @param wrappedNative - Wrapped native (wSOL) mint address, or undefined.
 */
export function extractSolanaSwaps(
  txs: HeliusTransaction[],
  walletAddress: string,
  stables: ReadonlySet<string>,
  wrappedNative?: string,
): CreateSignalInput[] {
  const isCounter = (mint: string): boolean =>
    stables.has(mint) || (wrappedNative !== undefined && mint === wrappedNative);

  const swaps: CreateSignalInput[] = [];

  for (const tx of txs) {
    if (tx.type !== 'SWAP') continue;
    if (!Array.isArray(tx.tokenTransfers)) continue;

    // Cast to the typed array — HeliusTransaction declares tokenTransfers: HeliusTokenTransfer[]
    // but the index signature [key: string]: unknown can shadow it in some TS configs.
    const transfers = tx.tokenTransfers as import('@cclaw/adapters-helius').HeliusTokenTransfer[];

    // Split by direction (mirrors legacy `ins` / `outs`)
    const ins = transfers.filter((t) => t.toUserAccount === walletAddress);
    const outs = transfers.filter((t) => t.fromUserAccount === walletAddress);
    if (ins.length === 0 || outs.length === 0) continue;

    // Identify counter/subject (legacy uses `find` — first match only)
    const counterIn = ins.find((t) => isCounter(t.mint));
    const counterOut = outs.find((t) => isCounter(t.mint));
    const subjectIn = ins.find((t) => !isCounter(t.mint));
    const subjectOut = outs.find((t) => !isCounter(t.mint));

    let action: 'buy' | 'sell';
    let subject: (typeof transfers)[number];
    let counter: (typeof transfers)[number];

    if (counterOut && subjectIn) {
      action = 'buy';
      subject = subjectIn;
      counter = counterOut;
    } else if (subjectOut && counterIn) {
      action = 'sell';
      subject = subjectOut;
      counter = counterIn;
    } else {
      continue;
    }

    // Symbol resolution — mirrors legacy `symFor()` helper
    const symFor = (t: (typeof transfers)[number]): string | null =>
      t.tokenSymbol ?? t.tokenName ?? (t.mint ? t.mint.slice(0, 8) : null);

    swaps.push({
      tx_hash: tx.signature,
      action,
      token_address: subject.mint,
      token_symbol: symFor(subject),
      counter_token_address: counter.mint,
      counter_token_symbol: symFor(counter),
      amount_token: String(subject.tokenAmount ?? ''),
      tx_timestamp: new Date((tx.timestamp ?? 0) * 1000).toISOString(),
    });
  }

  return swaps;
}
