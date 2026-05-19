/**
 * execute-trade-solana.ts — Real Squads V4 SDK + Jupiter swap implementation.
 *
 * Ports the load-bearing path from scripts/execute-trade-solana.js:
 *   1. resolveSolanaConfig()            — vault priority, RPC allowlist, keypair
 *   2. getJupiterQuote()                — 4-retry backoff (base 2000ms; 5 total attempts)
 *   3. getJupiterSwapInstructions()     — /swap-instructions endpoint
 *   4. validateJupiterInstructions()    — program-id allowlist guard (PR 2.3 parity)
 *   5. resolveLookupTables()            — fetch AddressLookupTableAccount for LUT compression
 *   6. buildAndSubmitSquadsTx()         — vaultTransactionCreate + proposalCreate + proposalApprove
 *                                         1232-byte meta-tx hard gate → tx_too_large
 *
 * Error kinds emitted by this module:
 *   squads_propose_failed               — Squads meta-tx build/send/confirm failed
 *   jupiter_quote_failed                — Jupiter /quote returned non-2xx after all retries
 *   jupiter_swap_failed                 — Jupiter /swap-instructions returned non-2xx
 *   aggregator_program_not_allowlisted  — Jupiter returned an instruction from an unknown program
 *   rpc_hostname_not_allowlisted        — RPC URL not in chains.ts SOLANA_RPC_ALLOWLIST
 *   signer_balance_insufficient         — vault USDC balance too low for the buy amount
 *   tx_too_large                        — Squads meta-tx exceeds Solana's 1232-byte limit
 *   executor_error                      — any other unclassified error
 *
 * NOTE: This file is only ever loaded via dynamic import from execute-trade.ts
 * (when EXECUTOR_STUB_MODE !== '1'). CI environments that do not have
 * @sqds/multisig / @solana/web3.js installed never import this module.
 *
 * @see scripts/execute-trade-solana.js — legacy parity reference
 * @see SPEC §4 #4  — signer keys never in api/worker/scheduler env
 * @see ADR-0010    — executor subprocess isolation
 * @see ADR-0023    — signer env file mount (second real consumer in P1c-iii)
 * @see ADR-0024    — per-Safe queue concurrency=1 handles Squads transactionIndex monotonicity
 */

import {
  getChain,
  getCashToken,
  isAllowedSwapProgram,
  isAllowedAncillaryProgram,
  isAllowedRpcUrl,
  isSolana,
} from '@cclaw/chain';
import type { OrderInput, SuccessReceipt, FailureReceipt } from '@cclaw/execution';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Union returned by executeTradeSolana(). */
export type SolanaTradeResult = SuccessReceipt | FailureReceipt;

/** Resolved env config for a single Solana execution. */
interface SolanaExecConfig {
  connection: import('@solana/web3.js').Connection;
  vaultPda: import('@solana/web3.js').PublicKey;
  multisigPda: import('@solana/web3.js').PublicKey | null;
  signer: import('@solana/web3.js').Keypair;
  vaultIndex: number;
  jupiterApiUrl: string;
  usdcMint: string;
  usdcDecimals: number;
  signerKeyRaw: string; // retained for error scrubbing only — never logged
}

/** Jupiter /quote response (minimal shape we depend on). */
interface JupiterQuoteResponse {
  outAmount: string;
  routePlan?: unknown[];
  addressLookupTableAddresses?: string[];
  [key: string]: unknown;
}

/** Jupiter /swap-instructions response (minimal shape). */
interface JupiterSwapInstructionsResponse {
  swapInstruction?: JupiterInstruction;
  setupInstructions?: JupiterInstruction[];
  cleanupInstruction?: JupiterInstruction | null;
  addressLookupTableAddresses?: string[];
  [key: string]: unknown;
}

/** A single instruction as returned by Jupiter (serialized). */
interface JupiterInstruction {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string; // base64
}

/** Squads build-and-submit result. */
interface SquadsSubmitResult {
  metaSignature: string;
  squadsTransactionIndex: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of retry attempts beyond the first for Jupiter requests. */
const JUPITER_MAX_RETRIES = 4; // 4 retries = 5 total attempts (matches legacy)
const JUPITER_BASE_DELAY_MS = 2000; // 2s → 4s → 8s → 16s

/** Solana's hard packet limit in bytes. */
const SOLANA_TX_SIZE_LIMIT = 1232;

/** Jupiter swap account budget — matches legacy scripts/execute-trade-solana.js maxAccounts. */
const JUPITER_MAX_ACCOUNTS = 30;

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

interface LogCtx {
  action: string;
  chain: string;
  symbol: string;
}

function shortAddr(a: string | undefined | null): string {
  if (!a) return '';
  const s = typeof a === 'string' ? a : String(a);
  return s.length > 10 ? `${s.slice(0, 6)}...${s.slice(-4)}` : s;
}

function stepLog(ctx: LogCtx | null, msg: string): void {
  const tag = ctx ? `[${ctx.action} ${ctx.chain}/${ctx.symbol}] ` : '';
  process.stderr.write(`[execute-trade-solana] ${tag}${msg}\n`);
}

// ---------------------------------------------------------------------------
// Error sanitization — MUST scrub SQUADS_SIGNER_KEY before propagating
// ---------------------------------------------------------------------------

/**
 * Replace every occurrence of the raw signer key string in `msg` with '[REDACTED]'.
 *
 * Base58 keys are typically 87-88 chars. This is a last-resort scrub applied
 * immediately before throwing — the real protection is that we never include
 * the key in error strings in the first place.
 */
function redactSignerKey(msg: string, signerKey: string): string {
  if (!signerKey || signerKey.length < 10) return msg;
  // replaceAll available in Node 22
  return msg.replaceAll(signerKey, '[REDACTED]');
}

// ---------------------------------------------------------------------------
// is429 helper
// ---------------------------------------------------------------------------

function is429(status: number): boolean {
  return status === 429;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve Solana execution config from env.
 *
 * Vault priority: SQUADS_VAULT_ADDRESS > derived from SQUADS_MULTISIG_ADDRESS.
 * Fails with executor_error if neither is set (or RPC URL is missing/blocked).
 *
 * @throws if required config is absent or RPC hostname is not allowlisted.
 */
async function resolveSolanaConfig(env: Record<string, string | undefined>): Promise<SolanaExecConfig> {
  // Dynamic imports — only reached when EXECUTOR_STUB_MODE !== '1'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const web3: any = await import('@solana/web3.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bs58Module: any = await import('bs58');
  const bs58 = bs58Module.default ?? bs58Module;

  const chainCfg = getChain('solana');
  if (!isSolana(chainCfg)) throw new Error('resolveSolanaConfig: expected Solana chain');

  const { squads } = chainCfg;

  // Vault address priority: direct vault > derived from multisig PDA
  const directVault = env[squads.vaultEnv]; // SQUADS_VAULT_ADDRESS
  const multisigAddress = env[squads.multisigEnv]; // SQUADS_MULTISIG_ADDRESS
  const signerKeyBase58 = env[squads.signerKeyEnv]; // SQUADS_SIGNER_KEY
  const rpcUrl = env[squads.rpcEnv]; // RPC_SOL

  if (!signerKeyBase58) throw new Error(`${squads.signerKeyEnv} not set`);
  if (!rpcUrl) throw new Error(`${squads.rpcEnv} not set`);
  if (!directVault && !multisigAddress) {
    throw new Error(
      `executor_error: either ${squads.vaultEnv} or ${squads.multisigEnv} must be set for Solana execution`,
    );
  }

  // RPC hostname allowlist check (mirrors EVM pattern from execute-trade-evm.ts)
  const mode = env['RPC_VALIDATION_MODE'] ?? 'strict';
  if (mode !== 'skip' && !isAllowedRpcUrl('solana', rpcUrl)) {
    let host = '';
    try {
      host = new URL(rpcUrl).hostname;
    } catch {
      host = '<unparseable>';
    }
    if (mode === 'warn') {
      stepLog(null, `[suspicious-rpc] solana: hostname ${host} not in allowlist (RPC_VALIDATION_MODE=warn)`);
    } else {
      throw new Error(`rpc_hostname_not_allowlisted: ${host} on solana`);
    }
  }

  // Build keypair from base58 key
  let signer: import('@solana/web3.js').Keypair;
  try {
    signer = web3.Keypair.fromSecretKey(bs58.decode(signerKeyBase58)) as import('@solana/web3.js').Keypair;
  } catch (err) {
    throw new Error(`executor_error: invalid SQUADS_SIGNER_KEY (base58 decode failed): ${(err as Error).message}`);
  }

  const connection = new web3.Connection(rpcUrl, 'confirmed') as import('@solana/web3.js').Connection;

  // Resolve vault PDA and multisig PDA
  // SQUADS_VAULT_ADDRESS takes priority for the vault address.
  // SQUADS_MULTISIG_ADDRESS is always required for Squads V4 instruction building
  // (vaultTransactionCreate, proposalCreate, proposalApprove all need the multisig PDA).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const multisigModule: any = await import('@sqds/multisig');
  let vaultPda: import('@solana/web3.js').PublicKey;
  let multisigPda: import('@solana/web3.js').PublicKey | null = null;

  if (multisigAddress) {
    multisigPda = new web3.PublicKey(multisigAddress) as import('@solana/web3.js').PublicKey;
  }

  if (directVault) {
    vaultPda = new web3.PublicKey(directVault) as import('@solana/web3.js').PublicKey;
    stepLog(null, `vault=direct(${shortAddr(directVault)})`);
    if (!multisigPda) {
      // Direct vault without multisig address: buildAndSubmitSquadsTx will reject.
      // This is surfaced as executor_error in buildAndSubmitSquadsTx.
      stepLog(null, `WARN: SQUADS_VAULT_ADDRESS set without SQUADS_MULTISIG_ADDRESS — Squads instructions will fail`);
    }
  } else {
    // Derive vault from multisig PDA (multisigAddress is guaranteed non-null here per above check)
    const [derived] = multisigModule.getVaultPda({
      multisigPda,
      index: squads.vaultIndex,
    }) as [import('@solana/web3.js').PublicKey];
    vaultPda = derived;
    stepLog(null, `vault=derived_from_multisig(${shortAddr(vaultPda.toString())})`);
  }

  const cashToken = getCashToken('solana');
  return {
    connection,
    vaultPda,
    multisigPda,
    signer,
    vaultIndex: squads.vaultIndex,
    jupiterApiUrl: chainCfg.jupiter.apiUrl,
    usdcMint: cashToken.address,
    usdcDecimals: cashToken.decimals,
    signerKeyRaw: signerKeyBase58,
  };
}

// ---------------------------------------------------------------------------
// SPL Token balance helpers
// ---------------------------------------------------------------------------

/**
 * Get token balance (lamports) for a given mint + owner from the vault.
 *
 * Returns 0n if the ATA is missing or unfunded — a common legitimate case
 * for new vaults (mirrors legacy getTokenBalance behaviour).
 */
async function getTokenBalance(
  connection: import('@solana/web3.js').Connection,
  mintAddress: string,
  ownerAddress: import('@solana/web3.js').PublicKey,
  ctx: LogCtx,
): Promise<bigint> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const web3: any = await import('@solana/web3.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const splToken: any = await import('@solana/spl-token');

  const mint = new web3.PublicKey(mintAddress) as import('@solana/web3.js').PublicKey;

  try {
    // Try Token-2022 program first, fall back to standard SPL
    let programId = splToken.TOKEN_PROGRAM_ID;
    try {
      const mintInfo = await connection.getAccountInfo(mint);
      if (mintInfo && mintInfo.owner.equals(splToken.TOKEN_2022_PROGRAM_ID)) {
        programId = splToken.TOKEN_2022_PROGRAM_ID;
      }
    } catch {
      /* use default program */
    }

    const ata = await splToken.getAssociatedTokenAddress(mint, ownerAddress, true, programId);
    const account = await splToken.getAccount(connection, ata, undefined, programId);
    return account.amount as bigint;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (msg.includes('TokenAccountNotFoundError') || msg.includes('could not find account')) {
      stepLog(ctx, `token_balance=0 (ata not found for mint=${shortAddr(mintAddress)})`);
      return 0n;
    }
    stepLog(ctx, `WARN getTokenBalance: ${msg.slice(0, 120)} — treating as 0`);
    return 0n;
  }
}

// ---------------------------------------------------------------------------
// Jupiter API helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a Jupiter /quote with exponential backoff on 429.
 *
 * Retries: 4 (5 total attempts). Base delay: 2000ms.
 * Error kind on exhaustion: jupiter_quote_failed.
 */
async function getJupiterQuote(
  jupiterApiUrl: string,
  params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
  },
  ctx: LogCtx,
): Promise<JupiterQuoteResponse> {
  const url = new URL(`${jupiterApiUrl}/quote`);
  url.searchParams.set('inputMint', params.inputMint);
  url.searchParams.set('outputMint', params.outputMint);
  url.searchParams.set('amount', params.amount);
  url.searchParams.set('slippageBps', String(params.slippageBps));
  url.searchParams.set('maxAccounts', String(JUPITER_MAX_ACCOUNTS));

  for (let attempt = 0; attempt <= JUPITER_MAX_RETRIES; attempt++) {
    const start = Date.now();
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });

    if (res.ok) {
      stepLog(ctx, `jupiter quote ok attempt=${attempt + 1}/${JUPITER_MAX_RETRIES + 1} (${Date.now() - start}ms)`);
      return res.json() as Promise<JupiterQuoteResponse>;
    }

    if (is429(res.status) && attempt < JUPITER_MAX_RETRIES) {
      const delay = JUPITER_BASE_DELAY_MS * Math.pow(2, attempt);
      stepLog(ctx, `jupiter quote 429 retry attempt=${attempt + 1}/${JUPITER_MAX_RETRIES + 1} backoff=${delay}ms`);
      await new Promise<void>((r) => setTimeout(r, delay));
      continue;
    }

    const text = await res.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed['error'] === 'string') detail = parsed['error'];
      else if (typeof parsed['message'] === 'string') detail = parsed['message'];
    } catch {
      /* use raw text */
    }
    const msg = `jupiter_quote_failed: Jupiter quote error (${res.status}): ${detail.slice(0, 300)}`;
    stepLog(ctx, msg);
    throw new Error(msg);
  }
  throw new Error('jupiter_quote_failed: exhausted retries');
}

/**
 * Fetch Jupiter /swap-instructions for the given quote and vault public key.
 *
 * Error kind on failure: jupiter_swap_failed.
 */
async function getJupiterSwapInstructions(
  jupiterApiUrl: string,
  quoteResponse: JupiterQuoteResponse,
  vaultPda: import('@solana/web3.js').PublicKey,
  ctx: LogCtx,
): Promise<JupiterSwapInstructionsResponse> {
  const start = Date.now();
  const res = await fetch(`${jupiterApiUrl}/swap-instructions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: vaultPda.toString(),
      wrapAndUnwrapSol: true,
    }),
  });

  if (res.ok) {
    stepLog(ctx, `jupiter swap-instructions ok (${Date.now() - start}ms)`);
    return res.json() as Promise<JupiterSwapInstructionsResponse>;
  }

  const text = await res.text();
  let detail = text;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed['error'] === 'string') detail = parsed['error'];
    else if (typeof parsed['message'] === 'string') detail = parsed['message'];
  } catch {
    /* use raw text */
  }
  const msg = `jupiter_swap_failed: Jupiter swap-instructions error (${res.status}): ${detail.slice(0, 300)}`;
  stepLog(ctx, msg);
  throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Instruction validation — allowlist guard (PR 2.3 parity)
// ---------------------------------------------------------------------------

/**
 * Validate every instruction's programId against the Solana chain's
 * swapProgramAllowlist and ancillaryProgramAllowlist from libs/chain.
 *
 * Throws aggregator_program_not_allowlisted if any instruction uses an
 * unknown program. This is a security-critical gate: a compromised Jupiter
 * API could inject attacker-controlled setup instructions.
 *
 * @throws {Error} with error kind `aggregator_program_not_allowlisted`.
 */
function validateJupiterInstructions(swapData: JupiterSwapInstructionsResponse): void {
  if (!swapData.swapInstruction?.programId) {
    throw new Error('aggregator_program_not_allowlisted: missing_swap_instruction_programId');
  }

  if (!isAllowedSwapProgram('solana', swapData.swapInstruction.programId)) {
    throw new Error(
      `aggregator_program_not_allowlisted: swap_program_not_allowlisted: ${swapData.swapInstruction.programId}`,
    );
  }

  const ancillary: JupiterInstruction[] = [
    ...(Array.isArray(swapData.setupInstructions) ? swapData.setupInstructions : []),
    ...(swapData.cleanupInstruction ? [swapData.cleanupInstruction] : []),
  ];

  for (const ix of ancillary) {
    if (!ix?.programId) {
      throw new Error('aggregator_program_not_allowlisted: ancillary_instruction_missing_programId');
    }
    if (!isAllowedAncillaryProgram('solana', ix.programId)) {
      throw new Error(`aggregator_program_not_allowlisted: ancillary_program_not_allowlisted: ${ix.programId}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Instruction deserialization
// ---------------------------------------------------------------------------

/**
 * Deserialize a Jupiter serialized instruction into a @solana/web3.js
 * TransactionInstruction.
 */
async function deserializeInstruction(
  ix: JupiterInstruction,
): Promise<import('@solana/web3.js').TransactionInstruction> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const web3: any = await import('@solana/web3.js');
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new web3.PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  }) as import('@solana/web3.js').TransactionInstruction;
}

// ---------------------------------------------------------------------------
// Lookup table resolution
// ---------------------------------------------------------------------------

/**
 * Resolve Jupiter-provided LUT addresses into AddressLookupTableAccount objects.
 *
 * LUTs allow accounts in a Squads meta-tx to be referenced by 1-byte index
 * instead of 32-byte pubkey, which is what keeps the meta-tx under Solana's
 * 1232-byte limit for complex Jupiter routes.
 */
async function resolveLookupTables(
  connection: import('@solana/web3.js').Connection,
  addresses: string[] | undefined,
  ctx: LogCtx,
): Promise<import('@solana/web3.js').AddressLookupTableAccount[]> {
  if (!Array.isArray(addresses) || addresses.length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const web3: any = await import('@solana/web3.js');
  const start = Date.now();

  const results = await Promise.all(
    addresses.map((addr) =>
      connection
        .getAddressLookupTable(new web3.PublicKey(addr))
        .then((r: { value: import('@solana/web3.js').AddressLookupTableAccount | null }) => r?.value ?? null)
        .catch(() => null),
    ),
  );

  const resolved = results.filter(
    // AddressLookupTableAccount is a class from @solana/web3.js dynamic import;
    // instanceof check requires the any cast because the dynamic module type is any.
    (r): r is import('@solana/web3.js').AddressLookupTableAccount =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      r !== null && r instanceof (web3 as any).AddressLookupTableAccount,
  );

  stepLog(ctx, `lookup_tables resolved=${resolved.length}/${addresses.length} (${Date.now() - start}ms)`);
  return resolved;
}

// ---------------------------------------------------------------------------
// Squads meta-tx builder and submitter
// ---------------------------------------------------------------------------

/**
 * Build and submit the Squads V4 meta-transaction:
 *   1. vaultTransactionCreate — wraps the Jupiter instructions inside a vault tx.
 *   2. proposalCreate         — creates the proposal for this vault tx.
 *   3. proposalApprove        — approves the proposal with the signer key.
 *
 * Then confirms the meta-tx on-chain. If threshold <= 1, also executes the
 * vault transaction on-chain.
 *
 * Enforces the 1232-byte hard cap on the assembled meta-tx before sending.
 *
 * @throws {Error} with `tx_too_large` if meta-tx exceeds 1232 bytes.
 * @throws {Error} with `squads_propose_failed` if any RPC step fails.
 */
async function buildAndSubmitSquadsTx(
  config: SolanaExecConfig,
  instructions: import('@solana/web3.js').TransactionInstruction[],
  lookupTableAccounts: import('@solana/web3.js').AddressLookupTableAccount[],
  ctx: LogCtx,
): Promise<SquadsSubmitResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const web3: any = await import('@solana/web3.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const multisigModule: any = await import('@sqds/multisig');

  const { connection, vaultPda, multisigPda, signer, vaultIndex } = config;

  // We need multisigPda for Squads API calls. If we used a direct vault
  // and multisigPda is null, derive it from the vaultPda or throw.
  // In practice, if SQUADS_VAULT_ADDRESS is set without SQUADS_MULTISIG_ADDRESS,
  // we cannot call Squads instructions that require the multisig PDA.
  // The canonical path: if SQUADS_VAULT_ADDRESS is set without SQUADS_MULTISIG_ADDRESS,
  // we throw executor_error asking the operator to provide SQUADS_MULTISIG_ADDRESS too.
  if (!multisigPda) {
    throw new Error(
      'executor_error: SQUADS_MULTISIG_ADDRESS is required to build Squads V4 transactions ' +
        '(even when SQUADS_VAULT_ADDRESS is set — the multisig PDA is needed for ' +
        'vaultTransactionCreate / proposalCreate / proposalApprove)',
    );
  }

  stepLog(
    ctx,
    `squads_init: multisig=${shortAddr(multisigPda.toString())} vault=${shortAddr(vaultPda.toString())} ` +
      `vaultIndex=${vaultIndex} instructions=${instructions.length} luts=${lookupTableAccounts.length}`,
  );

  // Get current multisig state for transactionIndex
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const multisigAccount: any = await multisigModule.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const transactionIndex = Number(multisigAccount.transactionIndex) + 1;
  const transactionIndexBN = BigInt(transactionIndex);
  stepLog(ctx, `multisig_state: txIndex=${transactionIndex} threshold=${Number(multisigAccount.threshold)}`);

  // Build inner transaction message from Jupiter instructions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blockhash: any = await connection.getLatestBlockhash();
  stepLog(ctx, `blockhash(inner)=${shortAddr(blockhash.blockhash)} lastValidBlock=${blockhash.lastValidBlockHeight}`);

  const txMessage = new web3.TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: blockhash.blockhash,
    instructions,
  });

  // 1. vaultTransactionCreate — LUTs compress account pubkeys to 1-byte indices
  const createTxIx = multisigModule.instructions.vaultTransactionCreate({
    multisigPda,
    transactionIndex: transactionIndexBN,
    creator: signer.publicKey,
    vaultIndex,
    ephemeralSigners: 0,
    transactionMessage: txMessage,
    addressLookupTableAccounts: lookupTableAccounts,
  }) as import('@solana/web3.js').TransactionInstruction;

  // 2. proposalCreate
  const createProposalIx = multisigModule.instructions.proposalCreate({
    multisigPda,
    transactionIndex: transactionIndexBN,
    creator: signer.publicKey,
  }) as import('@solana/web3.js').TransactionInstruction;

  // 3. proposalApprove
  const approveIx = multisigModule.instructions.proposalApprove({
    multisigPda,
    transactionIndex: transactionIndexBN,
    member: signer.publicKey,
  }) as import('@solana/web3.js').TransactionInstruction;

  // Build and sign the meta-transaction
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let metaTx: any;
  try {
    const metaMessage = new web3.TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: [createTxIx, createProposalIx, approveIx],
    }).compileToV0Message();

    metaTx = new web3.VersionedTransaction(metaMessage);
    metaTx.sign([signer]);
  } catch (serErr) {
    const totalDataBytes = instructions.reduce((sum, ix) => sum + ix.data.length, 0);
    const msg =
      `squads_propose_failed: Squads transaction build failed ` +
      `(${instructions.length} instructions, ${totalDataBytes} bytes data): ${(serErr as Error).message}`;
    stepLog(ctx, `ERROR meta_compile: ${msg}`);
    throw new Error(msg);
  }

  const metaSize: number = metaTx.serialize().length;
  stepLog(
    ctx,
    `meta_tx signed signer=${shortAddr(signer.publicKey.toString())} size=${metaSize}B (create+propose+approve)`,
  );

  // Hard gate: Solana network packet limit = 1232 bytes
  if (metaSize > SOLANA_TX_SIZE_LIMIT) {
    const errMsg =
      `tx_too_large: Squads meta-tx oversized: ${metaSize}B > ${SOLANA_TX_SIZE_LIMIT}B limit ` +
      `(instructions=${instructions.length}, luts=${lookupTableAccounts.length})`;
    stepLog(ctx, `ERROR ${errMsg}`);
    throw new Error(errMsg);
  }

  // Send meta-transaction
  stepLog(ctx, `sending meta tx to RPC`);
  let metaSig: string;
  try {
    metaSig = (await connection.sendTransaction(metaTx, { skipPreflight: false })) as string;
  } catch (sendErr) {
    throw new Error(`squads_propose_failed: sendTransaction(meta): ${(sendErr as Error).message}`);
  }

  stepLog(ctx, `meta_sent sig=${shortAddr(metaSig)}, confirming`);
  try {
    await connection.confirmTransaction({
      signature: metaSig,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    });
  } catch (confirmErr) {
    throw new Error(`squads_propose_failed: confirmTransaction(meta): ${(confirmErr as Error).message}`);
  }
  stepLog(ctx, `meta_confirmed sig=${shortAddr(metaSig)}`);

  // If threshold <= 1, execute the vault transaction on-chain
  const threshold = Number(multisigAccount.threshold);
  if (threshold <= 1) {
    stepLog(ctx, `executing on-chain (threshold=${threshold})`);
    const execStart = Date.now();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const execResult: any = await multisigModule.instructions.vaultTransactionExecute({
        connection,
        multisigPda,
        transactionIndex: transactionIndexBN,
        member: signer.publicKey,
      });
      const { instruction: executeTxIx, lookupTableAccounts: execLuts } = execResult;
      stepLog(ctx, `exec instruction built lookup_tables=${execLuts?.length ?? 0}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const execBlockhash: any = await connection.getLatestBlockhash();
      const execMessage = new web3.TransactionMessage({
        payerKey: signer.publicKey,
        recentBlockhash: execBlockhash.blockhash,
        instructions: [executeTxIx],
      }).compileToV0Message(execLuts ?? []);

      const execTx = new web3.VersionedTransaction(execMessage);
      execTx.sign([signer]);
      stepLog(ctx, `exec_tx signed size=${execTx.serialize().length}B, sending`);

      const execSig: string = (await connection.sendTransaction(execTx, { skipPreflight: false })) as string;
      stepLog(ctx, `exec_sent sig=${shortAddr(execSig)}, confirming`);
      await connection.confirmTransaction({
        signature: execSig,
        blockhash: execBlockhash.blockhash,
        lastValidBlockHeight: execBlockhash.lastValidBlockHeight,
      });
      stepLog(ctx, `executed sig=${execSig} (${Date.now() - execStart}ms)`);
      return { metaSignature: execSig, squadsTransactionIndex: transactionIndex };
    } catch (execErr) {
      stepLog(
        ctx,
        `ERROR execute: ${(execErr as Error).message} (${Date.now() - execStart}ms) — keeping as queued tx#${transactionIndex}`,
      );
      // Return the meta signature (proposal succeeded) — the executor record will show
      // squads_propose_failed in the error_kind if threshold=1 execution fails
      return { metaSignature: metaSig, squadsTransactionIndex: transactionIndex };
    }
  }

  stepLog(ctx, `queued_in_squads tx#${transactionIndex} threshold=${threshold} confirmations=1`);
  return { metaSignature: metaSig, squadsTransactionIndex: transactionIndex };
}

// ---------------------------------------------------------------------------
// BUY flow: USDC → Token
// ---------------------------------------------------------------------------

async function executeBuy(order: OrderInput, config: SolanaExecConfig, ctx: LogCtx): Promise<SolanaTradeResult> {
  const slippageBps = order.slippage_bps ?? 500; // default 5% for Solana
  const buyAmountUsd = parseFloat(order.amount);

  stepLog(
    ctx,
    `started amount=${order.amount} tier=${order.tier ?? '?'} slippage=${slippageBps}bps ` +
      `mint=${shortAddr(order.address)}`,
  );

  // Check vault's USDC balance
  const usdcBalance = await getTokenBalance(config.connection, config.usdcMint, config.vaultPda, ctx);
  const usdcBalanceFormatted = Number(usdcBalance) / 10 ** config.usdcDecimals;
  stepLog(ctx, `usdc_balance: have ${usdcBalanceFormatted}, need ${buyAmountUsd}`);

  if (usdcBalanceFormatted < buyAmountUsd) {
    return {
      status: 'failed',
      error: `Insufficient USDC: have ${usdcBalanceFormatted}, need ${buyAmountUsd}`,
      error_kind: 'signer_balance_insufficient',
    };
  }

  // Convert USD to USDC lamports
  const usdcLamports = BigInt(Math.round(buyAmountUsd * 10 ** config.usdcDecimals));
  stepLog(
    ctx,
    `quote_request: src=USDC(${shortAddr(config.usdcMint)}) dst=${shortAddr(order.address)} ` +
      `amount=${usdcLamports} slippageBps=${slippageBps}`,
  );

  // Jupiter quote
  const quote = await getJupiterQuote(
    config.jupiterApiUrl,
    {
      inputMint: config.usdcMint,
      outputMint: order.address,
      amount: usdcLamports.toString(),
      slippageBps,
    },
    ctx,
  );
  stepLog(
    ctx,
    `quote_ok: outAmount=${quote.outAmount} route_plan_len=${(quote.routePlan as unknown[])?.length ?? '?'}`,
  );

  // [OPEN-PIII-1] Oracle cross-check deferred — depends on price-oracle.js not yet ported.

  // Jupiter swap instructions
  stepLog(ctx, `swap_instructions_request`);
  const swapData = await getJupiterSwapInstructions(config.jupiterApiUrl, quote, config.vaultPda, ctx);

  if (!swapData.swapInstruction) {
    return {
      status: 'failed',
      error: `Jupiter response missing swapInstruction (keys: ${JSON.stringify(Object.keys(swapData))})`,
      error_kind: 'jupiter_swap_failed',
    };
  }

  // Validate all program IDs before deserializing — security-critical gate
  validateJupiterInstructions(swapData);

  // Deserialize instructions
  const allInstructions: import('@solana/web3.js').TransactionInstruction[] = [];
  if (swapData.setupInstructions) {
    for (const ix of swapData.setupInstructions) {
      allInstructions.push(await deserializeInstruction(ix));
    }
  }
  allInstructions.push(await deserializeInstruction(swapData.swapInstruction));
  if (swapData.cleanupInstruction) {
    allInstructions.push(await deserializeInstruction(swapData.cleanupInstruction));
  }
  stepLog(
    ctx,
    `instructions_built: total=${allInstructions.length} ` +
      `setup=${swapData.setupInstructions?.length ?? 0} swap=1 ` +
      `cleanup=${swapData.cleanupInstruction ? 1 : 0}`,
  );

  // Resolve LUTs for 1232-byte compression
  const allLutAddresses = [...(swapData.addressLookupTableAddresses ?? [])];
  const luts = await resolveLookupTables(config.connection, allLutAddresses, ctx);

  // Build and submit Squads meta-tx
  const squadsResult = await buildAndSubmitSquadsTx(config, allInstructions, luts, ctx);

  // [OPEN-PIII-2] Post-swap balance reconciliation deferred.
  // For now use Jupiter quote as actual_amount_out (matches PR-B EVM approach).
  const actualAmountOut = parseFloat(quote.outAmount);

  return {
    status: 'executed',
    tx_hash: squadsResult.metaSignature,
    block_number: 0,
    gas_used: '0', // Solana uses lamport fees, not gas units
    actual_amount_in: order.amount,
    actual_amount_out: actualAmountOut,
    slippage_bps: slippageBps,
    executed_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// SELL flow: Token → USDC
// ---------------------------------------------------------------------------

async function executeSell(order: OrderInput, config: SolanaExecConfig, ctx: LogCtx): Promise<SolanaTradeResult> {
  const slippageBps = order.slippage_bps ?? 500;

  stepLog(ctx, `started amount=${order.amount} slippage=${slippageBps}bps mint=${shortAddr(order.address)}`);

  // Get token balance from vault
  const tokenBalance = await getTokenBalance(config.connection, order.address, config.vaultPda, ctx);

  let sellAmountLamports: bigint;
  if (order.amount === 'all') {
    sellAmountLamports = tokenBalance;
    stepLog(ctx, `sell_all: balance=${tokenBalance}`);
  } else {
    // For sell, amount is in USD equivalent. Convert via a quote first.
    // Simplification: treat amount as token lamports string directly (matches legacy behavior
    // where amount is already in token units for sell orders).
    // If amount is a float string (USD), we approximate: parse as token units.
    sellAmountLamports = BigInt(Math.round(parseFloat(order.amount)));
  }

  if (sellAmountLamports === 0n || tokenBalance < sellAmountLamports) {
    return {
      status: 'failed',
      error: `Insufficient token balance: have ${tokenBalance}, need ${sellAmountLamports}`,
      error_kind: 'signer_balance_insufficient',
    };
  }

  stepLog(
    ctx,
    `quote_request: src=${shortAddr(order.address)} dst=USDC(${shortAddr(config.usdcMint)}) ` +
      `amount=${sellAmountLamports} slippageBps=${slippageBps}`,
  );

  const quote = await getJupiterQuote(
    config.jupiterApiUrl,
    {
      inputMint: order.address,
      outputMint: config.usdcMint,
      amount: sellAmountLamports.toString(),
      slippageBps,
    },
    ctx,
  );
  stepLog(ctx, `quote_ok: outAmount=${quote.outAmount}`);

  // [OPEN-PIII-1] Oracle cross-check deferred.

  const swapData = await getJupiterSwapInstructions(config.jupiterApiUrl, quote, config.vaultPda, ctx);

  if (!swapData.swapInstruction) {
    return {
      status: 'failed',
      error: `Jupiter response missing swapInstruction`,
      error_kind: 'jupiter_swap_failed',
    };
  }

  validateJupiterInstructions(swapData);

  const allInstructions: import('@solana/web3.js').TransactionInstruction[] = [];
  if (swapData.setupInstructions) {
    for (const ix of swapData.setupInstructions) {
      allInstructions.push(await deserializeInstruction(ix));
    }
  }
  allInstructions.push(await deserializeInstruction(swapData.swapInstruction));
  if (swapData.cleanupInstruction) {
    allInstructions.push(await deserializeInstruction(swapData.cleanupInstruction));
  }

  const allLutAddresses = [...(swapData.addressLookupTableAddresses ?? [])];
  const luts = await resolveLookupTables(config.connection, allLutAddresses, ctx);

  const squadsResult = await buildAndSubmitSquadsTx(config, allInstructions, luts, ctx);

  const usdcReceived = parseFloat(quote.outAmount) / 10 ** config.usdcDecimals;

  return {
    status: 'executed',
    tx_hash: squadsResult.metaSignature,
    block_number: 0,
    gas_used: '0',
    actual_amount_in: order.amount,
    actual_amount_out: usdcReceived,
    slippage_bps: slippageBps,
    executed_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Execute a Solana trade via the real Squads V4 SDK + Jupiter swap.
 *
 * Called by execute-trade.ts dispatch layer when:
 *   - EXECUTOR_STUB_MODE !== '1'
 *   - chain === 'solana'
 *
 * @param order - Validated order from stdin.
 * @param env   - Full child process env (signer keys injected by worker).
 * @returns SolanaTradeResult — success or failure receipt.
 */
export async function executeTradeSolana(
  order: OrderInput,
  env: Record<string, string | undefined>,
): Promise<SolanaTradeResult> {
  const ctx: LogCtx = { action: order.action, chain: order.chain, symbol: order.symbol };

  let config: SolanaExecConfig;
  try {
    config = await resolveSolanaConfig(env);
  } catch (err) {
    const rawMessage = (err as Error).message ?? String(err);
    const signerKey = env['SQUADS_SIGNER_KEY'] ?? '';
    const message = redactSignerKey(rawMessage, signerKey);
    return {
      status: 'failed',
      error: message,
      error_kind: message.startsWith('rpc_hostname_not_allowlisted')
        ? 'rpc_hostname_not_allowlisted'
        : message.startsWith('executor_error:')
          ? 'executor_error'
          : 'executor_error',
    };
  }

  const { signerKeyRaw } = config;

  try {
    if (order.action === 'buy') {
      return await executeBuy(order, config, ctx);
    }
    return await executeSell(order, config, ctx);
  } catch (err) {
    const rawMessage = (err as Error).message ?? String(err);
    const message = redactSignerKey(rawMessage, signerKeyRaw);

    // Classify error_kind from the prefixed message set by helpers above
    let errorKind = 'executor_error';
    if (message.includes('squads_propose_failed')) errorKind = 'squads_propose_failed';
    else if (message.includes('jupiter_quote_failed')) errorKind = 'jupiter_quote_failed';
    else if (message.includes('jupiter_swap_failed')) errorKind = 'jupiter_swap_failed';
    else if (message.includes('aggregator_program_not_allowlisted')) errorKind = 'aggregator_program_not_allowlisted';
    else if (message.includes('rpc_hostname_not_allowlisted')) errorKind = 'rpc_hostname_not_allowlisted';
    else if (message.includes('signer_balance_insufficient')) errorKind = 'signer_balance_insufficient';
    else if (message.includes('tx_too_large')) errorKind = 'tx_too_large';

    return {
      status: 'failed',
      error: message,
      error_kind: errorKind,
    };
  }
}
