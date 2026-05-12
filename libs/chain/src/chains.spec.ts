/**
 * Unit tests for libs/chain/src/chains.ts
 *
 * Verifies the TypeScript port has identical values and behavior to
 * scripts/chains.js. No API calls; pure in-process.
 */
import { describe, it, expect } from 'vitest';
import {
  CHAINS,
  PORTFOLIO_RULES,
  getChain,
  getActiveChains,
  getAllChains,
  getPortfolioRules,
  getTierMaxUsd,
  getSignerThreshold,
  getQuarantineTokenAgeHours,
  getCashToken,
  getStablecoins,
  getBaseTierTokens,
  getAggregator,
  isAllowedRouter,
  isAllowedSwapProgram,
  isAllowedAncillaryProgram,
  isAllowedRpcUrl,
  isEvm,
  isSolana,
} from './chains.js';

// ---------------------------------------------------------------------------
// CHAINS map
// ---------------------------------------------------------------------------

describe('CHAINS map', () => {
  it('has base, ethereum, and solana', () => {
    expect(Object.keys(CHAINS)).toEqual(expect.arrayContaining(['base', 'ethereum', 'solana']));
  });

  it('base chain has correct chainId and type', () => {
    const base = CHAINS['base']!;
    expect(base.type).toBe('evm');
    if (isEvm(base)) {
      expect(base.chainId).toBe('8453');
      expect(base.safe.txServiceUrl).toBe('https://safe-transaction-base.safe.global');
    }
  });

  it('solana chain has type solana and squads config', () => {
    const sol = CHAINS['solana']!;
    expect(sol.type).toBe('solana');
    if (isSolana(sol)) {
      expect(sol.squads.rpcEnv).toBe('RPC_SOL');
      expect(sol.chainId).toBeNull();
    }
  });

  it('ethereum cashToken is USDC on mainnet', () => {
    const eth = CHAINS['ethereum']!;
    expect(eth.cashToken.address).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  });
});

// ---------------------------------------------------------------------------
// PORTFOLIO_RULES
// ---------------------------------------------------------------------------

describe('PORTFOLIO_RULES', () => {
  it('has expected safety limits matching scripts/chains.js', () => {
    expect(PORTFOLIO_RULES.maxMoonshotPosition).toBe(5);
    expect(PORTFOLIO_RULES.maxConvictionPosition).toBe(10);
    expect(PORTFOLIO_RULES.maxBasePosition).toBe(30);
    expect(PORTFOLIO_RULES.minCashReserve).toBe(10);
    expect(PORTFOLIO_RULES.tierMaxUsd.moonshot).toBe(200);
    expect(PORTFOLIO_RULES.tierMaxUsd.conviction).toBe(500);
    expect(PORTFOLIO_RULES.tierMaxUsd.base).toBe(2000);
    expect(PORTFOLIO_RULES.quarantineTokenAgeHours).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// getChain
// ---------------------------------------------------------------------------

describe('getChain()', () => {
  it('returns chain by name', () => {
    expect(getChain('base').name).toBe('base');
  });

  it('throws for unknown chain', () => {
    expect(() => getChain('unknown-chain-xyz')).toThrow('Unknown chain');
  });
});

// ---------------------------------------------------------------------------
// getActiveChains
// ---------------------------------------------------------------------------

describe('getActiveChains()', () => {
  it('returns base+ethereum+solana when ACTIVE_CHAINS not set', () => {
    const chains = getActiveChains({} as Record<string, string | undefined>);
    expect(chains).toEqual(expect.arrayContaining(['base', 'ethereum', 'solana']));
  });

  it('parses comma-separated list', () => {
    const chains = getActiveChains({ ACTIVE_CHAINS: 'base,solana' });
    expect(chains).toEqual(['base', 'solana']);
  });

  it('filters out unknown chain names', () => {
    const chains = getActiveChains({ ACTIVE_CHAINS: 'base,unknown-xyz,solana' });
    expect(chains).toEqual(['base', 'solana']);
  });
});

// ---------------------------------------------------------------------------
// getAllChains
// ---------------------------------------------------------------------------

describe('getAllChains()', () => {
  it('returns all known chain names', () => {
    const all = getAllChains();
    expect(all).toContain('base');
    expect(all).toContain('ethereum');
    expect(all).toContain('solana');
  });
});

// ---------------------------------------------------------------------------
// getPortfolioRules
// ---------------------------------------------------------------------------

describe('getPortfolioRules()', () => {
  it('returns global defaults for base (no chain-level overrides)', () => {
    const rules = getPortfolioRules('base');
    expect(rules.maxMoonshotPosition).toBe(5);
    expect(rules.maxOpenPositions).toBe(15);
  });

  it('applies solana-specific overrides', () => {
    const rules = getPortfolioRules('solana');
    expect(rules.maxMoonshotPosition).toBe(7); // Solana override
    expect(rules.maxOpenPositions).toBe(10); // Solana override
    // Global defaults still apply for non-overridden fields
    expect(rules.minCashReserve).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// getTierMaxUsd
// ---------------------------------------------------------------------------

describe('getTierMaxUsd()', () => {
  it('returns global default for base moonshot', () => {
    expect(getTierMaxUsd('base', 'moonshot', {})).toBe(200);
  });

  it('env var TIER_MAX_USD_MOONSHOT overrides default', () => {
    expect(getTierMaxUsd('base', 'moonshot', { TIER_MAX_USD_MOONSHOT: '300' })).toBe(300);
  });

  it('returns null for unknown tier', () => {
    expect(getTierMaxUsd('base', 'unknown_tier', {})).toBeNull();
  });

  it('rejects negative env value, falls back to chain default', () => {
    expect(getTierMaxUsd('base', 'moonshot', { TIER_MAX_USD_MOONSHOT: '-100' })).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// getSignerThreshold
// ---------------------------------------------------------------------------

describe('getSignerThreshold()', () => {
  it('base threshold is 0.001 ETH', () => {
    expect(getSignerThreshold('base')).toBe(0.001);
  });

  it('solana threshold is 0.05 SOL', () => {
    expect(getSignerThreshold('solana')).toBe(0.05);
  });
});

// ---------------------------------------------------------------------------
// getQuarantineTokenAgeHours
// ---------------------------------------------------------------------------

describe('getQuarantineTokenAgeHours()', () => {
  it('returns 24 by default', () => {
    expect(getQuarantineTokenAgeHours('base', {})).toBe(24);
  });

  it('respects QUARANTINE_TOKEN_AGE_HOURS=0 (disable)', () => {
    expect(getQuarantineTokenAgeHours('base', { QUARANTINE_TOKEN_AGE_HOURS: '0' })).toBe(0);
  });

  it('respects QUARANTINE_TOKEN_AGE_HOURS=48 (tighten)', () => {
    expect(getQuarantineTokenAgeHours('base', { QUARANTINE_TOKEN_AGE_HOURS: '48' })).toBe(48);
  });
});

// ---------------------------------------------------------------------------
// getCashToken
// ---------------------------------------------------------------------------

describe('getCashToken()', () => {
  it('base cash token is USDC', () => {
    const ct = getCashToken('base');
    expect(ct.symbol).toBe('USDC');
    expect(ct.decimals).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// getStablecoins
// ---------------------------------------------------------------------------

describe('getStablecoins()', () => {
  it('returns a Set of lowercased addresses for EVM', () => {
    const set = getStablecoins('base');
    expect(set instanceof Set).toBe(true);
    // Addresses are lowercased
    for (const addr of set) {
      expect(addr).toBe(addr.toLowerCase());
    }
  });

  it('contains USDC for base', () => {
    const set = getStablecoins('base');
    expect(set.has('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Aggregator helpers
// ---------------------------------------------------------------------------

describe('getAggregator()', () => {
  it('base aggregator is 1inch-v6', () => {
    const agg = getAggregator('base');
    expect(agg?.name).toBe('1inch-v6');
  });

  it('solana aggregator is jupiter-v6', () => {
    const agg = getAggregator('solana');
    expect(agg?.name).toBe('jupiter-v6');
  });
});

describe('isAllowedRouter()', () => {
  it('returns true for 1inch v6 router on base (case-insensitive)', () => {
    expect(isAllowedRouter('base', '0x111111125421cA6dc452d289314280a0f8842A65')).toBe(true);
    expect(isAllowedRouter('base', '0x111111125421ca6dc452d289314280a0f8842a65')).toBe(true);
  });

  it('returns false for unknown address', () => {
    expect(isAllowedRouter('base', '0xdeadbeefdeadbeef')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAllowedRouter('base', null)).toBe(false);
  });
});

describe('isAllowedSwapProgram()', () => {
  it('returns true for Jupiter v6 program on solana', () => {
    expect(isAllowedSwapProgram('solana', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')).toBe(true);
  });

  it('returns false for unknown program', () => {
    expect(isAllowedSwapProgram('solana', 'unknownProgramXXX')).toBe(false);
  });

  it('returns false for EVM chain (no swapProgramAllowlist)', () => {
    expect(isAllowedSwapProgram('base', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')).toBe(false);
  });
});

describe('isAllowedAncillaryProgram()', () => {
  it('returns true for SPL Token program', () => {
    expect(isAllowedAncillaryProgram('solana', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(true);
  });

  it('returns true for System Program', () => {
    expect(isAllowedAncillaryProgram('solana', '11111111111111111111111111111111')).toBe(true);
  });

  it('returns false for unknown program', () => {
    expect(isAllowedAncillaryProgram('solana', 'UnknownProgramAAAA')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAllowedRpcUrl
// ---------------------------------------------------------------------------

describe('isAllowedRpcUrl()', () => {
  it('accepts alchemy.com subdomain for base', () => {
    expect(isAllowedRpcUrl('base', 'https://base-mainnet.g.alchemy.com/v2/key')).toBe(true);
  });

  it('accepts mainnet.base.org (exact)', () => {
    expect(isAllowedRpcUrl('base', 'https://mainnet.base.org')).toBe(true);
  });

  it('rejects attacker-controlled URL', () => {
    expect(isAllowedRpcUrl('base', 'https://evil.attacker.com/rpc')).toBe(false);
  });

  it('returns false for malformed URL', () => {
    expect(isAllowedRpcUrl('base', 'not-a-url')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAllowedRpcUrl('base', null)).toBe(false);
  });

  it('accepts helius for solana', () => {
    expect(isAllowedRpcUrl('solana', 'https://mainnet.helius-rpc.com/?api-key=xxx')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

describe('type guards', () => {
  it('isEvm() returns true for base', () => {
    expect(isEvm(getChain('base'))).toBe(true);
  });

  it('isSolana() returns true for solana', () => {
    expect(isSolana(getChain('solana'))).toBe(true);
  });

  it('isEvm() returns false for solana', () => {
    expect(isEvm(getChain('solana'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getBaseTierTokens
// ---------------------------------------------------------------------------

describe('getBaseTierTokens()', () => {
  it('base chain has WETH in base tier tokens', () => {
    const tokens = getBaseTierTokens('base');
    expect(tokens.some((t) => t.symbol === 'WETH')).toBe(true);
  });
});
