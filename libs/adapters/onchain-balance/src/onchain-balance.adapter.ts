/**
 * OnchainBalanceAdapter — Read on-chain token balances for position reconciliation.
 *
 * Ports the `fetchOnchainTokenBalance` and `fetchTokenDecimals` helpers from
 * `scripts/onchain-balance.js` into a NestJS-injectable adapter.
 *
 * EVM: reads via viem `readContract` (ERC-20 balanceOf / decimals).
 * Solana: reads via @solana/web3.js Connection + @solana/spl-token ATA lookup.
 *
 * RPC URLs are resolved from ConfigService per ADR-0026 (per-field get).
 * The `RPC_VALIDATION_MODE` guard is honoured (assertRpcAllowed).
 *
 * SPEC §4 #4: no signer keys read here (read-only RPC calls).
 * SPEC §4 #6: no `process.env` reads — all config via ConfigService.
 * ADR-0026: per-field config access only.
 * DoD §I: byte-identical behaviour with `scripts/onchain-balance.js`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { getChain, isEvm, isSolana, isAllowedRpcUrl, type EvmChain, type SolanaChain } from '@cclaw/chain';

// ---------------------------------------------------------------------------
// ERC-20 ABI fragment (mirrors scripts/onchain-balance.js)
// ---------------------------------------------------------------------------

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when the RPC hostname is not on the allowlist. */
export class OnchainRpcNotAllowlistedError extends Error {
  constructor(
    public readonly host: string,
    public readonly chainName: string,
  ) {
    super(`rpc_hostname_not_allowlisted: ${host} on ${chainName}`);
    this.name = 'OnchainRpcNotAllowlistedError';
  }
}

/** Thrown when a required RPC URL env var is not configured. */
export class OnchainRpcUrlMissingError extends Error {
  constructor(public readonly envVar: string) {
    super(`RPC URL not configured: ${envVar}`);
    this.name = 'OnchainRpcUrlMissingError';
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Injectable adapter for on-chain token balance reads.
 *
 * Used by the position-reconcile processor to verify that DB-recorded quantities
 * match the actual vault holdings.
 */
@Injectable()
export class OnchainBalanceAdapter {
  private readonly logger = new Logger(OnchainBalanceAdapter.name);

  constructor(private readonly configService: ConfigService) {}

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve an RPC URL from ConfigService and validate against the allowlist.
   *
   * Bug-for-bug port of `scripts/onchain-balance.js:assertRpcAllowed` (line 33).
   * ADR-0026: per-field get via configService.
   */
  private resolveAndAssertRpc(envVar: string, chainName: string): string {
    const rpcUrl = this.configService.get<string>(envVar);
    if (!rpcUrl) throw new OnchainRpcUrlMissingError(envVar);

    const mode = this.configService.get<string>('RPC_VALIDATION_MODE') ?? 'strict';
    if (mode === 'skip') return rpcUrl;
    if (isAllowedRpcUrl(chainName, rpcUrl)) return rpcUrl;

    let host = '';
    try {
      host = new URL(rpcUrl).hostname;
    } catch {
      host = '<unparseable>';
    }
    if (mode === 'warn') {
      this.logger.warn(`onchain-balance: RPC hostname ${host} not on allowlist for ${chainName} (warn mode)`);
      return rpcUrl;
    }
    throw new OnchainRpcNotAllowlistedError(host, chainName);
  }

  // ---------------------------------------------------------------------------
  // EVM helpers
  // ---------------------------------------------------------------------------

  /**
   * EVM: read ERC-20 balance of `owner` for arbitrary token.
   *
   * Port of `scripts/onchain-balance.js:fetchEvmTokenBalance` (DoD §I).
   */
  private async getEvmTokenBalance(
    evmChain: EvmChain,
    chainName: string,
    tokenAddress: string,
    owner: string,
    decimals: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const rpcUrl = this.resolveAndAssertRpc(evmChain.safe.rpcEnv, chainName);
    const client = createPublicClient({ transport: http(rpcUrl, { fetchOptions: { signal } }) });
    const balance = await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [owner as `0x${string}`],
    });
    return parseFloat(formatUnits(balance as bigint, decimals));
  }

  /**
   * EVM: read ERC-20 decimals for a token.
   *
   * Port of `scripts/onchain-balance.js:fetchTokenDecimals` EVM branch (DoD §I).
   */
  private async getEvmTokenDecimals(
    evmChain: EvmChain,
    chainName: string,
    tokenAddress: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const rpcUrl = this.resolveAndAssertRpc(evmChain.safe.rpcEnv, chainName);
    const client = createPublicClient({ transport: http(rpcUrl, { fetchOptions: { signal } }) });
    const decimals = await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    return Number(decimals);
  }

  // ---------------------------------------------------------------------------
  // Solana helpers
  // ---------------------------------------------------------------------------

  /**
   * Solana: read SPL-token ATA balance for `owner` of arbitrary mint.
   * Returns 0 if the ATA doesn't exist (fresh buy hasn't created it yet).
   *
   * Port of `scripts/onchain-balance.js:fetchSolanaTokenBalance` (DoD §I).
   */
  private async getSolanaTokenBalance(
    solChain: SolanaChain,
    chainName: string,
    mintAddress: string,
    owner: string,
    decimals: number,
  ): Promise<number> {
    const rpcUrl = this.resolveAndAssertRpc(solChain.squads.rpcEnv, chainName);
    const connection = new Connection(rpcUrl, 'confirmed');
    const mint = new PublicKey(mintAddress);
    const ownerKey = new PublicKey(owner);

    const mintInfo = await connection.getAccountInfo(mint);
    if (!mintInfo) throw new Error(`Mint not found: ${mintAddress}`);
    const programId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    try {
      const ata = await getAssociatedTokenAddress(mint, ownerKey, true, programId);
      const account = await getAccount(connection, ata, undefined, programId);
      return Number(account.amount) / 10 ** decimals;
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      if (msg.includes('TokenAccountNotFoundError') || msg.includes('could not find account')) {
        return 0; // fresh vault — no holdings
      }
      throw err;
    }
  }

  /**
   * Solana: read SPL mint decimals via account info byte at offset 44.
   *
   * Port of `scripts/onchain-balance.js:fetchTokenDecimals` Solana branch (DoD §I).
   */
  private async getSolanaTokenDecimals(solChain: SolanaChain, chainName: string, mintAddress: string): Promise<number> {
    const rpcUrl = this.resolveAndAssertRpc(solChain.squads.rpcEnv, chainName);
    const connection = new Connection(rpcUrl, 'confirmed');
    const mint = new PublicKey(mintAddress);
    const mintInfo = await connection.getAccountInfo(mint);
    if (!mintInfo) throw new Error(`Mint not found: ${mintAddress}`);
    // SPL Mint layout: decimals is byte at offset 44 (DoD §I parity).
    return mintInfo.data[44] as number;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fetch the on-chain token balance for a given vault/owner address.
   *
   * Dispatches to EVM or Solana implementation based on chain.
   * Signal is passed through for per-call wall-clock caps.
   *
   * @param chainName - e.g. 'base', 'ethereum', 'solana'.
   * @param tokenAddress - Token contract (EVM) or mint (Solana) address.
   * @param owner - Safe address (EVM) or vault pubkey (Solana).
   * @param decimals - Token decimals (use `getTokenDecimals` if unknown).
   * @param signal - Optional AbortSignal for timeout.
   */
  async getTokenBalance(
    chainName: string,
    tokenAddress: string,
    owner: string,
    decimals: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const chain = getChain(chainName);
    if (isEvm(chain)) return this.getEvmTokenBalance(chain, chainName, tokenAddress, owner, decimals, signal);
    if (isSolana(chain)) return this.getSolanaTokenBalance(chain, chainName, tokenAddress, owner, decimals);
    throw new Error(`Unsupported chain for token-balance read: ${chainName}`);
  }

  /**
   * Fetch token decimals from on-chain.
   *
   * Used by position-reconcile when the positions table doesn't carry
   * decimals as a column.
   *
   * @param chainName - e.g. 'base', 'ethereum', 'solana'.
   * @param tokenAddress - Token contract (EVM) or mint (Solana) address.
   * @param signal - Optional AbortSignal for timeout (EVM only).
   */
  async getTokenDecimals(chainName: string, tokenAddress: string, signal?: AbortSignal): Promise<number> {
    const chain = getChain(chainName);
    if (isEvm(chain)) return this.getEvmTokenDecimals(chain, chainName, tokenAddress, signal);
    if (isSolana(chain)) return this.getSolanaTokenDecimals(chain, chainName, tokenAddress);
    throw new Error(`Unsupported chain for decimals read: ${chainName}`);
  }
}
