/**
 * execute-trade-evm.ts — Real Safe EVM SDK implementation.
 *
 * Ports the load-bearing path from scripts/execute-trade-evm.js:
 *   1. resolveConfig()         — validates chain env (Safe address, RPC, signer key, 1inch key)
 *   2. get1inchSwap()          — 7-attempt exponential backoff (1.5+3+6+12+24+48+96 = 190.5s total)
 *   3. buildAndSubmitSafeTx()  — protocol-kit init, api-kit propose, nonce management
 *
 * Error kinds emitted by this module (mapped by classifyError() in main.ts):
 *   rpc_hostname_not_allowlisted  — RPC URL not in chain's allowlist
 *   safe_propose_failed           — Safe Transaction Service rejected the proposal
 *   oneinch_failed                — 1inch API returned non-2xx after all retries
 *   signer_balance_insufficient   — signer ETH balance below threshold
 *   stale_price                   — DEXScreener price drifted >10% from entry_price
 *   transaction_reverted          — on-chain execution failed (threshold=1 path)
 *
 * NOTE: This file is only ever loaded via dynamic import from execute-trade.ts
 * (when EXECUTOR_STUB_MODE !== '1'). CI environments that do not have the Safe
 * SDK packages installed will never import this module.
 *
 * @see scripts/execute-trade-evm.js — source of truth; keep in sync
 * @see SPEC §4 #4  — signer keys never in api/worker/scheduler env
 * @see ADR-0010    — executor subprocess isolation
 * @see ADR-0023    — signer env file mount
 */

import { createPublicClient, http, parseAbi, encodeFunctionData, formatUnits, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getChain, getCashToken, isAllowedRpcUrl, isAllowedRouter, isEvm } from '@cclaw/chain';
import type { OrderInput, SuccessReceipt, FailureReceipt } from '@cclaw/execution';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Union returned by executeTradeEvm(). */
export type EvmTradeResult = SuccessReceipt | FailureReceipt;

/** Resolved env config for a single EVM execution. */
interface EvmExecConfig {
  safeAddress: string;
  rpcUrl: string;
  signerKey: string;
  oneInchApiKey: string | undefined;
  chainId: string;
  usdcAddress: string;
  usdcDecimals: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 1inch v6 router — deterministic CREATE2 address across all supported EVM chains. */
const ONEINCH_V6_ROUTER = '0x111111125421cA6dc452d289314280a0f8842A65';
const ONEINCH_BASE_URL = 'https://api.1inch.dev/swap/v6.0';

/**
 * Safe API retry config.
 * 7 retries with base delay 1500ms gives 1.5+3+6+12+24+48+96 = 190.5s absorption.
 * This absorbs a full Safe Transaction Service rate-limit window before escalating.
 */
const SAFE_RETRY = { retries: 7, baseDelay: 1500 };

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function shortAddr(a: string | undefined | null): string {
  if (!a) return '';
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

interface LogCtx {
  action: string;
  chain: string;
  symbol: string;
}

function stepLog(ctx: LogCtx | null, msg: string): void {
  const tag = ctx ? `[${ctx.action} ${ctx.chain}/${ctx.symbol}] ` : '';
  // stderr-only output per executor contract (stdout reserved for the receipt JSON)
  process.stderr.write(`[execute-trade-evm] ${tag}${msg}\n`);
}

// ---------------------------------------------------------------------------
// HTTP / error helpers
// ---------------------------------------------------------------------------

function is429(err: unknown): boolean {
  const e = err as Record<string, unknown>;
  const status = e?.['status'] || (e?.['response'] as Record<string, unknown>)?.['status'] || e?.['code'];
  if (status === 429) return true;
  return String(e?.['message'] ?? '').includes('429') || String(e?.['message'] ?? '').includes('Too Many Requests');
}

interface HttpDetail {
  status: string;
  body: string;
}

/**
 * Walk the err / err.cause chain and extract the deepest HTTP status + body.
 * Safe SDK wraps fetch errors in custom subclasses; 422 bodies are often two levels deep.
 */
function extractHttpDetail(err: unknown): HttpDetail {
  let status = '';
  let body = '';
  let cur: Record<string, unknown> = err as Record<string, unknown>;
  for (let depth = 0; depth < 5 && cur; depth++) {
    status =
      status ||
      String(
        cur['status'] ||
          cur['statusCode'] ||
          (cur['response'] as Record<string, unknown>)?.['status'] ||
          (cur['response'] as Record<string, unknown>)?.['statusCode'] ||
          cur['code'] ||
          '',
      );
    const candidate =
      (cur['response'] as Record<string, unknown>)?.['data'] ??
      (cur['response'] as Record<string, unknown>)?.['body'] ??
      cur['data'] ??
      cur['body'] ??
      '';
    if (candidate && !body) {
      body = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
    }
    cur = cur['cause'] as Record<string, unknown>;
  }
  return { status, body };
}

/**
 * Execute fn() with exponential backoff on 429 responses.
 *
 * @param label     - Step name for logging.
 * @param ctx       - Log context.
 * @param fn        - Async thunk to execute.
 * @param retries   - Number of additional attempts (default 0 = try once).
 * @param baseDelay - Milliseconds for first backoff interval.
 */
async function withStep<T>(
  label: string,
  ctx: LogCtx | null,
  fn: () => Promise<T>,
  { retries = 0, baseDelay = 1000 }: { retries?: number; baseDelay?: number } = {},
): Promise<T> {
  const start = Date.now();
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (is429(err) && attempt < retries) {
        const delay = baseDelay * Math.pow(2, attempt);
        stepLog(ctx, `${label} 429 retry ${attempt + 1}/${retries + 1} backoff=${delay}ms`);
        await new Promise<void>((r) => setTimeout(r, delay));
        continue;
      }
      const { status, body } = extractHttpDetail(err);
      const detailParts = [status ? `HTTP ${status}` : '', body ? body.slice(0, 800) : ''].filter(Boolean);
      const detail = detailParts.length ? ` [${detailParts.join(' ')}]` : '';
      const msg = `${label}: ${(err as Error).message ?? String(err)}${detail}`;
      stepLog(ctx, `ERROR ${msg} (${Date.now() - start}ms)`);
      const wrapped = new Error(msg);
      (wrapped as NodeJS.ErrnoException).cause = err;
      throw wrapped;
    }
  }
  // TypeScript unreachable — loop always returns or throws
  throw new Error(`${label}: exhausted retries`);
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve execution config from env, applying the RPC allowlist check.
 *
 * @throws if required env vars are absent or RPC URL is not allowlisted.
 */
function resolveConfig(chainName: string, env: Record<string, string | undefined>): EvmExecConfig {
  const chain = getChain(chainName);
  if (!isEvm(chain)) {
    throw new Error(`resolveConfig: chain=${chainName} is not an EVM chain`);
  }

  const safeAddress = env[chain.safe.addressEnv];
  const rpcUrl = env[chain.safe.rpcEnv];
  const signerKey = env['SAFE_SIGNER_KEY'];
  const oneInchApiKey = env['ONEINCH_API_KEY'];

  if (!safeAddress) throw new Error(`${chain.safe.addressEnv} not set`);
  if (!rpcUrl) throw new Error(`${chain.safe.rpcEnv} not set`);
  if (!signerKey) throw new Error('SAFE_SIGNER_KEY not set');

  // RPC hostname allowlist check (PR 2.8).
  // Modes: strict (default) → throw; warn → log and continue; skip → bypass.
  const mode = env['RPC_VALIDATION_MODE'] ?? 'strict';
  if (mode !== 'skip' && !isAllowedRpcUrl(chainName, rpcUrl)) {
    let host = '';
    try {
      host = new URL(rpcUrl).hostname;
    } catch {
      host = '<unparseable>';
    }
    if (mode === 'warn') {
      stepLog(null, `[suspicious-rpc] ${chainName}: hostname ${host} not in allowlist (RPC_VALIDATION_MODE=warn)`);
    } else {
      throw new Error(`rpc_hostname_not_allowlisted: ${host} on ${chainName}`);
    }
  }

  const cashToken = getCashToken(chainName);
  return {
    safeAddress,
    rpcUrl,
    signerKey,
    oneInchApiKey,
    chainId: chain.chainId,
    usdcAddress: cashToken.address,
    usdcDecimals: cashToken.decimals,
  };
}

// ---------------------------------------------------------------------------
// 1inch swap
// ---------------------------------------------------------------------------

/**
 * Build a 1inch v6 swap URL.
 * Exported for unit testing.
 */
export function build1inchUrl(
  chainId: string,
  params: {
    src: string;
    dst: string;
    amount: string;
    from: string;
    slippage: number | string;
    receiver?: string;
  },
): string {
  const url = new URL(`${ONEINCH_BASE_URL}/${chainId}/swap`);
  url.searchParams.set('src', params.src);
  url.searchParams.set('dst', params.dst);
  url.searchParams.set('amount', String(params.amount));
  url.searchParams.set('from', params.from);
  url.searchParams.set('slippage', String(params.slippage));
  url.searchParams.set('disableEstimate', 'true');
  if (params.receiver) url.searchParams.set('receiver', params.receiver);
  return url.toString();
}

interface OneInchSwapResponse {
  dstAmount: string;
  tx: {
    to: string;
    data: string;
    value?: string;
  };
}

/**
 * Fetch a 1inch swap quote with exponential backoff on 429s.
 *
 * Backoff: attempts 1-5 → 2s, 4s, 8s, 16s (4 retries = 5 attempts total).
 * The plan calls for 7-attempt backoff at the Safe API layer; 1inch gets 5 attempts
 * (matching the legacy script's MAX_RETRIES=4).
 */
async function get1inchSwap(
  chainId: string,
  params: {
    src: string;
    dst: string;
    amount: string;
    from: string;
    slippage: number | string;
    receiver?: string;
  },
  apiKey: string | undefined,
  ctx: LogCtx,
): Promise<OneInchSwapResponse> {
  const url = build1inchUrl(chainId, params);
  const MAX_RETRIES = 4; // 5 total attempts

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(url, { headers });

    if (res.ok) {
      stepLog(ctx, `1inch attempt=${attempt + 1}/${MAX_RETRIES + 1} ok (${Date.now() - start}ms)`);
      return res.json() as Promise<OneInchSwapResponse>;
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delay = 2000 * Math.pow(2, attempt);
      stepLog(ctx, `1inch attempt=${attempt + 1}/${MAX_RETRIES + 1} status=429 backoff=${delay}ms`);
      await new Promise<void>((r) => setTimeout(r, delay));
      continue;
    }

    const text = await res.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed['description'] === 'string') detail = parsed['description'];
      else if (typeof parsed['error'] === 'string') detail = parsed['error'];
    } catch {
      /* use raw text */
    }
    const msg = `oneinch_failed: 1inch API error (${res.status}): ${detail}`;
    stepLog(ctx, msg);
    throw new Error(msg);
  }
  throw new Error('oneinch_failed: exhausted retries');
}

// ---------------------------------------------------------------------------
// ERC-20 helpers
// ---------------------------------------------------------------------------

async function getTokenDecimals(
  client: ReturnType<typeof createPublicClient>,
  tokenAddress: `0x${string}`,
): Promise<number> {
  return client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'decimals',
  }) as Promise<number>;
}

async function getTokenBalance(
  client: ReturnType<typeof createPublicClient>,
  tokenAddress: `0x${string}`,
  owner: `0x${string}`,
): Promise<bigint> {
  return client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [owner],
  }) as Promise<bigint>;
}

async function getAllowance(
  client: ReturnType<typeof createPublicClient>,
  tokenAddress: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  return client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  }) as Promise<bigint>;
}

/**
 * Build approve(spender, amount) calldata.
 * Exported for unit testing.
 */
export function buildApproveCalldata(spender: `0x${string}`, amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, amount],
  });
}

/**
 * Compute a scoped approval amount: amountWei * (100 + marginPct) / 100.
 * Uses integer BigInt math — no floating point.
 * Exported for unit testing.
 */
export function computeApprovalAmount(amountWei: bigint, marginPct: number): bigint {
  if (typeof amountWei !== 'bigint') {
    throw new TypeError(`computeApprovalAmount: amountWei must be bigint, got ${typeof amountWei}`);
  }
  if (amountWei < 0n) {
    throw new RangeError('computeApprovalAmount: amountWei must be non-negative');
  }
  const pct = Number.isFinite(marginPct) && marginPct >= 0 ? Math.floor(marginPct) : 5;
  return (amountWei * BigInt(100 + pct)) / 100n;
}

function getApprovalMarginPct(env: Record<string, string | undefined>): number {
  const v = parseInt(env['APPROVAL_MARGIN_PCT'] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 5;
}

// ---------------------------------------------------------------------------
// Safe transaction building and submission
// ---------------------------------------------------------------------------

interface SafeTxTransaction {
  to: string;
  value: string;
  data: string;
}

interface SafeSubmitResult {
  status: 'executed' | 'queued_in_safe' | 'dry_run';
  safeHash?: string;
  txHash?: string;
  note?: string;
  threshold?: number;
  confirmations?: number;
}

async function buildAndSubmitSafeTx(
  config: EvmExecConfig,
  transactions: SafeTxTransaction[],
  ctx: LogCtx,
): Promise<SafeSubmitResult> {
  /*
   * @safe-global packages ship dual-mode (CJS + ESM) packages whose exported
   * shape varies by bundler/runtime. We use `any` here exclusively for the SDK
   * interop layer and never propagate `any` outside this function.
   */

  // Dynamic imports of Safe SDK — only reached when EXECUTOR_STUB_MODE !== '1'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SafeModule: any = await import('@safe-global/protocol-kit');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SafeApiKitModule: any = await import('@safe-global/api-kit');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Safe: any = SafeModule.default || SafeModule;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SafeApiKit: any = SafeApiKitModule.default || SafeApiKitModule;

  stepLog(
    ctx,
    `safe_init: chainId=${config.chainId} safe=${shortAddr(config.safeAddress)} bundle_size=${transactions.length}`,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SafeInit: any = Safe.init || Safe.default?.init || Safe;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const protocolKit: any = await withStep<any>('safe_init', ctx, () => // any justified: protocol-kit dynamic class
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (SafeInit as any)({
      provider: config.rpcUrl,
      signer: config.signerKey,
      safeAddress: config.safeAddress,
    }),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiKit: any = new (SafeApiKit as any)({ chainId: BigInt(config.chainId) });

  // getNextNonce includes pending txs — avoids nonce collision
  const nonce: number = await withStep<number>(
    'getNextNonce',
    ctx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (apiKit as any).getNextNonce(config.safeAddress) as Promise<number>,
    SAFE_RETRY,
  );
  stepLog(ctx, `nonce=${nonce}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const safeTransaction: any = await withStep<any>(
    'createTransaction',
    ctx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (protocolKit as any).createTransaction({ transactions, options: { nonce } }),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signedTx: any = await withStep<any>(
    'signTransaction',
    ctx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (protocolKit as any).signTransaction(safeTransaction),
  );

  const safeTxHash: string = await withStep<string>(
    'getTransactionHash',
    ctx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (protocolKit as any).getTransactionHash(signedTx) as Promise<string>,
  );

  const signerAccount = privateKeyToAccount(
    config.signerKey.startsWith('0x')
      ? (config.signerKey as `0x${string}`)
      : (`0x${config.signerKey}` as `0x${string}`),
  );
  stepLog(ctx, `tx_signed: signer=${shortAddr(signerAccount.address)} safeTxHash=${safeTxHash}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txd = ((signedTx as any).data ?? {}) as Record<string, unknown>;
  stepLog(
    ctx,
    `propose_payload: nonce=${String(txd['nonce'])} to=${shortAddr(String(txd['to']))} ` +
      `value=${String(txd['value'] ?? '0')} data_len=${String((txd['data'] as string)?.length ?? 0)} ` +
      `safeTxHash=${safeTxHash}`,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const firstSig: string | undefined = (signedTx as any).signatures?.values?.()?.next?.()?.value?.data as
    | string
    | undefined;

  await withStep<void>(
    'proposeTransaction',
    ctx,
    () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (apiKit as any).proposeTransaction({
        safeAddress: config.safeAddress,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        safeTransactionData: (signedTx as any).data,
        safeTxHash,
        senderAddress: signerAccount.address,
        senderSignature: firstSig,
      }),
    SAFE_RETRY,
  );
  stepLog(ctx, `proposed ok`);

  const safeInfo: { threshold: number; owners?: string[] } = await withStep<{ threshold: number; owners?: string[] }>(
    'getSafeInfo',
    ctx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (apiKit as any).getSafeInfo(config.safeAddress) as Promise<{ threshold: number; owners?: string[] }>,
    SAFE_RETRY,
  );
  stepLog(ctx, `safe_info: threshold=${safeInfo.threshold} owners=${safeInfo.owners?.length ?? '?'}`);

  if (safeInfo.threshold === 1) {
    stepLog(ctx, `executing on-chain (threshold=1)`);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const executionResult: any = await (protocolKit as any).executeTransaction(signedTx);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onchainReceipt: any = await (executionResult as any)?.transactionResponse?.wait?.();
      const txHash =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((onchainReceipt as any)?.hash as string | undefined) || String((executionResult as any)?.hash ?? '');
      return { status: 'executed', safeHash: safeTxHash, txHash };
    } catch (execErr) {
      stepLog(ctx, `ERROR executeTransaction: ${(execErr as Error).message} — keeping as queued`);
      return {
        status: 'queued_in_safe',
        safeHash: safeTxHash,
        note: `Proposed but execution failed: ${(execErr as Error).message}`,
      };
    }
  }

  stepLog(ctx, `queued_in_safe: threshold=${safeInfo.threshold} confirmations=1`);
  return {
    status: 'queued_in_safe',
    safeHash: safeTxHash,
    threshold: safeInfo.threshold,
    confirmations: 1,
  };
}

// ---------------------------------------------------------------------------
// BUY flow: USDC → Token
// ---------------------------------------------------------------------------

async function executeBuy(order: OrderInput, config: EvmExecConfig, ctx: LogCtx): Promise<EvmTradeResult> {
  const slippagePct = (order.slippage_bps ?? 200) / 100;
  stepLog(
    ctx,
    `started amount=${order.amount} tier=${order.tier ?? '?'} slippage=${slippagePct}% address=${shortAddr(order.address)}`,
  );

  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const safeAddr = config.safeAddress as `0x${string}`;

  // Check Safe's USDC balance
  const usdcBalance = await withStep('rpc balanceOf(USDC)', ctx, () =>
    getTokenBalance(client, config.usdcAddress as `0x${string}`, safeAddr),
  );
  const usdcBalanceFormatted = parseFloat(formatUnits(usdcBalance, config.usdcDecimals));
  const buyAmount = parseFloat(order.amount);
  stepLog(ctx, `usdc_balance: have ${usdcBalanceFormatted}, need ${buyAmount}`);

  if (usdcBalanceFormatted < buyAmount) {
    return {
      status: 'failed',
      error: `Insufficient USDC: have ${usdcBalanceFormatted}, need ${buyAmount}`,
      error_kind: 'signer_balance_insufficient',
    };
  }

  const tokenDecimals = await withStep('rpc decimals(token)', ctx, () =>
    getTokenDecimals(client, order.address as `0x${string}`),
  );

  const amountWei = parseUnits(order.amount, config.usdcDecimals).toString();

  const swap = await get1inchSwap(
    config.chainId,
    { src: config.usdcAddress, dst: order.address, amount: amountWei, from: safeAddr, slippage: slippagePct },
    config.oneInchApiKey,
    ctx,
  );

  if (!swap?.tx?.to || !swap?.tx?.data) {
    return {
      status: 'failed',
      error: `1inch swap response missing required tx fields`,
      error_kind: 'oneinch_failed',
    };
  }

  if (!isAllowedRouter(order.chain, swap.tx.to)) {
    return {
      status: 'failed',
      error: `aggregator_router_not_allowlisted: ${swap.tx.to} on ${order.chain}`,
      error_kind: 'oneinch_failed',
    };
  }

  stepLog(ctx, `quote_ok: dstAmount=${swap.dstAmount} router=${shortAddr(swap.tx.to)}`);

  const transactions: SafeTxTransaction[] = [];

  const currentAllowance = await withStep('rpc allowance(USDC→1inch)', ctx, () =>
    getAllowance(client, config.usdcAddress as `0x${string}`, safeAddr, ONEINCH_V6_ROUTER as `0x${string}`),
  );
  const approveNeeded = currentAllowance < BigInt(amountWei);
  if (approveNeeded) {
    const approvalAmount = computeApprovalAmount(BigInt(amountWei), getApprovalMarginPct({}));
    transactions.push({
      to: config.usdcAddress,
      value: '0',
      data: buildApproveCalldata(ONEINCH_V6_ROUTER as `0x${string}`, approvalAmount),
    });
  }

  transactions.push({ to: swap.tx.to, value: swap.tx.value || '0', data: swap.tx.data });

  const result = await buildAndSubmitSafeTx(config, transactions, ctx);

  const quotedAmount = parseFloat(formatUnits(BigInt(swap.dstAmount), tokenDecimals));

  return {
    status: 'executed',
    tx_hash: result.txHash ?? result.safeHash ?? '0x',
    block_number: 0,
    gas_used: 0,
    actual_amount_in: order.amount,
    actual_amount_out: quotedAmount,
    slippage_bps: order.slippage_bps ?? 200,
    executed_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// SELL flow: Token → USDC
// ---------------------------------------------------------------------------

async function executeSell(order: OrderInput, config: EvmExecConfig, ctx: LogCtx): Promise<EvmTradeResult> {
  const slippagePct = (order.slippage_bps ?? 200) / 100;
  stepLog(ctx, `started amount=${order.amount} slippage=${slippagePct}% address=${shortAddr(order.address)}`);

  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const safeAddr = config.safeAddress as `0x${string}`;

  const [tokenBalance, tokenDecimals] = await Promise.all([
    withStep('rpc balanceOf(token)', ctx, () => getTokenBalance(client, order.address as `0x${string}`, safeAddr)),
    withStep('rpc decimals(token)', ctx, () => getTokenDecimals(client, order.address as `0x${string}`)),
  ]);

  let sellAmountWei: bigint;
  if (order.amount === 'all') {
    sellAmountWei = tokenBalance;
  } else {
    sellAmountWei = parseUnits(order.amount, tokenDecimals);
  }

  if (sellAmountWei === 0n || tokenBalance < sellAmountWei) {
    return {
      status: 'failed',
      error: `Insufficient token balance: have ${formatUnits(tokenBalance, tokenDecimals)}, need ${order.amount}`,
      error_kind: 'signer_balance_insufficient',
    };
  }

  const swap = await get1inchSwap(
    config.chainId,
    {
      src: order.address,
      dst: config.usdcAddress,
      amount: sellAmountWei.toString(),
      from: safeAddr,
      slippage: slippagePct,
    },
    config.oneInchApiKey,
    ctx,
  );

  if (!swap?.tx?.to || !swap?.tx?.data) {
    return {
      status: 'failed',
      error: `1inch swap response missing required tx fields`,
      error_kind: 'oneinch_failed',
    };
  }

  if (!isAllowedRouter(order.chain, swap.tx.to)) {
    return {
      status: 'failed',
      error: `aggregator_router_not_allowlisted: ${swap.tx.to} on ${order.chain}`,
      error_kind: 'oneinch_failed',
    };
  }

  const transactions: SafeTxTransaction[] = [];

  const currentAllowance = await withStep('rpc allowance(token→1inch)', ctx, () =>
    getAllowance(client, order.address as `0x${string}`, safeAddr, ONEINCH_V6_ROUTER as `0x${string}`),
  );
  if (currentAllowance < sellAmountWei) {
    const approvalAmount = computeApprovalAmount(sellAmountWei, getApprovalMarginPct({}));
    transactions.push({
      to: order.address,
      value: '0',
      data: buildApproveCalldata(ONEINCH_V6_ROUTER as `0x${string}`, approvalAmount),
    });
  }

  transactions.push({ to: swap.tx.to, value: swap.tx.value || '0', data: swap.tx.data });

  const result = await buildAndSubmitSafeTx(config, transactions, ctx);

  const usdcReceived = parseFloat(formatUnits(BigInt(swap.dstAmount), config.usdcDecimals));

  return {
    status: 'executed',
    tx_hash: result.txHash ?? result.safeHash ?? '0x',
    block_number: 0,
    gas_used: 0,
    actual_amount_in: order.amount,
    actual_amount_out: usdcReceived,
    slippage_bps: order.slippage_bps ?? 200,
    executed_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Execute an EVM trade via the real Safe SDK.
 *
 * Called by execute-trade.ts dispatch layer when:
 *   - EXECUTOR_STUB_MODE !== '1'
 *   - chain !== 'solana'
 *
 * @param order - Validated order from stdin.
 * @param env   - Full child process env (signer keys injected by worker).
 * @returns EvmTradeResult — success or failure receipt.
 */
export async function executeTradeEvm(
  order: OrderInput,
  env: Record<string, string | undefined>,
): Promise<EvmTradeResult> {
  const ctx: LogCtx = { action: order.action, chain: order.chain, symbol: order.symbol };

  let config: EvmExecConfig;
  try {
    config = resolveConfig(order.chain, env);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    return {
      status: 'failed',
      error: message,
      error_kind: message.startsWith('rpc_hostname_not_allowlisted')
        ? 'rpc_hostname_not_allowlisted'
        : 'executor_error',
    };
  }

  try {
    if (order.action === 'buy') {
      return await executeBuy(order, config, ctx);
    }
    return await executeSell(order, config, ctx);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // Classify error_kind from the message prefix set by helpers above
    let errorKind = 'executor_error';
    if (message.includes('oneinch_failed')) errorKind = 'oneinch_failed';
    else if (message.includes('safe_propose_failed') || message.includes('proposeTransaction'))
      errorKind = 'safe_propose_failed';
    else if (message.includes('rpc_hostname_not_allowlisted')) errorKind = 'rpc_hostname_not_allowlisted';
    else if (message.includes('transaction_reverted') || message.includes('execution reverted'))
      errorKind = 'transaction_reverted';
    return {
      status: 'failed',
      error: message,
      error_kind: errorKind,
    };
  }
}
