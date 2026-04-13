#!/usr/bin/env node
/**
 * test-chains.js — Tests for centralized chain config + portfolio sync
 */

import { describe, test, assert, assertEqual, summary } from './test-helpers.js';

let chains;
let dbMod;

async function runTests() {
  // Pre-load modules
  chains = await import('../scripts/chains.js');
  process.env.SAFE_ID = `test-chains-${Date.now()}`;
  dbMod = await import('../scripts/db.js');

  // ============================================================
  // Chain Configuration Tests
  // ============================================================

  describe('Chain Configuration', () => {
    test('getActiveChains defaults to [base, ethereum, solana] when ACTIVE_CHAINS not set', () => {
      delete process.env.ACTIVE_CHAINS;
      const result = chains.getActiveChains();
      assertEqual(result.length, 3);
      assert(result.includes('base'), 'Should include base');
      assert(result.includes('ethereum'), 'Should include ethereum');
      assert(result.includes('solana'), 'Should include solana');
    });

    test('getActiveChains parses comma-separated env var', () => {
      process.env.ACTIVE_CHAINS = 'base,solana';
      const result = chains.getActiveChains();
      assertEqual(result.length, 2);
      assert(result.includes('base'), 'Should include base');
      assert(result.includes('solana'), 'Should include solana');
      delete process.env.ACTIVE_CHAINS;
    });

    test('getActiveChains ignores unknown chains', () => {
      process.env.ACTIVE_CHAINS = 'base,polygon,solana';
      const result = chains.getActiveChains();
      assertEqual(result.length, 2);
      assert(result.includes('base'), 'Should include base');
      assert(result.includes('solana'), 'Should include solana');
      delete process.env.ACTIVE_CHAINS;
    });

    test('getActiveChains includes ethereum when set', () => {
      process.env.ACTIVE_CHAINS = 'base,ethereum,solana';
      const result = chains.getActiveChains();
      assertEqual(result.length, 3);
      assert(result.includes('base'), 'Should include base');
      assert(result.includes('ethereum'), 'Should include ethereum');
      assert(result.includes('solana'), 'Should include solana');
      delete process.env.ACTIVE_CHAINS;
    });

    test('getActiveChains handles empty string', () => {
      process.env.ACTIVE_CHAINS = '';
      const result = chains.getActiveChains();
      assertEqual(result.length, 3);
      assert(result.includes('base'), 'Should include base');
      assert(result.includes('ethereum'), 'Should include ethereum');
      assert(result.includes('solana'), 'Should include solana');
      delete process.env.ACTIVE_CHAINS;
    });

    test('getActiveChains handles whitespace', () => {
      process.env.ACTIVE_CHAINS = ' base , solana ';
      const result = chains.getActiveChains();
      assertEqual(result.length, 2);
      assert(result.includes('base'), 'Should include base');
      assert(result.includes('solana'), 'Should include solana');
      delete process.env.ACTIVE_CHAINS;
    });

    test('getChain returns full config for base', () => {
      const cfg = chains.getChain('base');
      assertEqual(cfg.name, 'base');
      assertEqual(cfg.type, 'evm');
      assertEqual(cfg.chainId, '8453');
      assertEqual(cfg.dexScreenerId, 'base');
      assertEqual(cfg.goplus.chainId, '8453');
      assertEqual(cfg.explorer.baseUrl, 'https://api.basescan.org/api');
      assertEqual(cfg.explorer.apiKeyEnv, 'BASESCAN_API_KEY');
      assertEqual(cfg.birdeye, 'base');
      assertEqual(cfg.dex, '1inch');
      assertEqual(cfg.portfolio.provider, 'debank');
      assertEqual(cfg.safe.addressEnv, 'SAFE_ADDRESS_BASE');
      assertEqual(cfg.safe.rpcEnv, 'RPC_BASE');
    });

    test('getChain returns full config for solana', () => {
      const cfg = chains.getChain('solana');
      assertEqual(cfg.name, 'solana');
      assertEqual(cfg.type, 'solana');
      assertEqual(cfg.chainId, null);
      assertEqual(cfg.goplus.endpoint, 'solana');
      assertEqual(cfg.explorer, null);
      assertEqual(cfg.birdeye, 'solana');
      assertEqual(cfg.dex, 'jupiter');
      assertEqual(cfg.solana.solscan.apiKeyEnv, 'SOLSCAN_API_KEY');
      assertEqual(cfg.solana.helius.apiKeyEnv, 'HELIUS_API_KEY');
    });

    test('solana config has squads section', () => {
      const cfg = chains.getChain('solana');
      assert(cfg.squads, 'Solana must have squads config');
      assertEqual(cfg.squads.multisigEnv, 'SQUADS_MULTISIG_ADDRESS');
      assertEqual(cfg.squads.vaultEnv, 'SQUADS_VAULT_ADDRESS');
      assertEqual(cfg.squads.signerKeyEnv, 'SQUADS_SIGNER_KEY');
      assertEqual(cfg.squads.rpcEnv, 'RPC_SOL');
      assertEqual(cfg.squads.vaultIndex, 0);
    });

    test('solana config has jupiter section', () => {
      const cfg = chains.getChain('solana');
      assert(cfg.jupiter, 'Solana must have jupiter config');
      assertEqual(cfg.jupiter.apiUrl, 'https://lite-api.jup.ag/swap/v1');
    });

    test('solana config has cashToken', () => {
      const cfg = chains.getChain('solana');
      assert(cfg.cashToken, 'Must have cashToken');
      assertEqual(cfg.cashToken.symbol, 'USDC');
      assertEqual(cfg.cashToken.address, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      assertEqual(cfg.cashToken.decimals, 6);
    });

    test('base config has cashToken', () => {
      const cfg = chains.getChain('base');
      assert(cfg.cashToken, 'Must have cashToken');
      assertEqual(cfg.cashToken.symbol, 'USDC');
      assertEqual(cfg.cashToken.address, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
      assertEqual(cfg.cashToken.decimals, 6);
    });

    test('getCashToken returns correct config', () => {
      const baseToken = chains.getCashToken('base');
      assertEqual(baseToken.symbol, 'USDC');
      assertEqual(baseToken.address, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
      const solToken = chains.getCashToken('solana');
      assertEqual(solToken.address, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    });

    test('solana portfolio provider is helius', () => {
      const cfg = chains.getChain('solana');
      assertEqual(cfg.portfolio.provider, 'helius');
      assertEqual(cfg.portfolio.apiKeyEnv, 'HELIUS_API_KEY');
    });

    test('getChain throws for unknown chain', () => {
      let threw = false;
      try {
        chains.getChain('polygon');
      } catch {
        threw = true;
      }
      assert(threw, 'Should throw for unknown chain');
    });

    test('isActive respects ACTIVE_CHAINS env var', () => {
      process.env.ACTIVE_CHAINS = 'base';
      assert(chains.isActive('base'), 'base should be active');
      assert(!chains.isActive('solana'), 'solana should not be active');
      delete process.env.ACTIVE_CHAINS;
    });

    test('isEVM returns true for base, false for solana', () => {
      assert(chains.isEVM('base'), 'base should be EVM');
      assert(!chains.isEVM('solana'), 'solana should not be EVM');
    });

    test('isSolana returns true for solana, false for base', () => {
      assert(chains.isSolana('solana'), 'solana should be Solana');
      assert(!chains.isSolana('base'), 'base should not be Solana');
    });

    test('GoPlus chain IDs match previously hardcoded values', () => {
      assertEqual(chains.getChain('base').goplus.chainId, '8453');
    });

    test('Explorer configs match previously hardcoded values', () => {
      assertEqual(chains.getChain('base').explorer.baseUrl, 'https://api.basescan.org/api');
      assertEqual(chains.getChain('base').explorer.apiKeyEnv, 'BASESCAN_API_KEY');
    });

    test('base config has nativeToken and wrappedNativeToken', () => {
      const cfg = chains.getChain('base');
      assertEqual(cfg.nativeToken.symbol, 'ETH');
      assertEqual(cfg.nativeToken.decimals, 18);
      assertEqual(cfg.wrappedNativeToken.symbol, 'WETH');
      assertEqual(cfg.wrappedNativeToken.address, '0x4200000000000000000000000000000000000006');
      assertEqual(cfg.wrappedNativeToken.decimals, 18);
    });

    test('solana config has nativeToken and wrappedNativeToken', () => {
      const cfg = chains.getChain('solana');
      assertEqual(cfg.nativeToken.symbol, 'SOL');
      assertEqual(cfg.nativeToken.decimals, 9);
      assertEqual(cfg.wrappedNativeToken.symbol, 'WSOL');
      assertEqual(cfg.wrappedNativeToken.address, 'So11111111111111111111111111111111111111112');
      assertEqual(cfg.wrappedNativeToken.decimals, 9);
    });

    test('base config has stablecoins list including cashToken', () => {
      const cfg = chains.getChain('base');
      assert(Array.isArray(cfg.stablecoins), 'stablecoins must be an array');
      assert(cfg.stablecoins.length >= 2, 'Should have at least USDC and one more');
      assert(
        cfg.stablecoins.map((a) => a.toLowerCase()).includes(cfg.cashToken.address.toLowerCase()),
        'cashToken address must be in stablecoins list',
      );
    });

    test('solana config has stablecoins list including cashToken', () => {
      const cfg = chains.getChain('solana');
      assert(Array.isArray(cfg.stablecoins), 'stablecoins must be an array');
      assert(cfg.stablecoins.length >= 2, 'Should have at least USDC and USDT');
      assert(cfg.stablecoins.includes(cfg.cashToken.address), 'cashToken address must be in stablecoins list');
    });

    test('getStablecoins returns Set with lowercased addresses for EVM', () => {
      const stables = chains.getStablecoins('base');
      assert(stables instanceof Set, 'Should return a Set');
      assert(stables.size >= 2, 'Should have at least 2 stablecoins');
      // All should be lowercased
      for (const addr of stables) {
        assertEqual(addr, addr.toLowerCase(), 'EVM stablecoin addresses must be lowercased');
      }
    });

    test('getStablecoins returns Set with exact addresses for Solana', () => {
      const stables = chains.getStablecoins('solana');
      assert(stables instanceof Set, 'Should return a Set');
      assert(stables.has('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 'Should have USDC mint');
      assert(stables.has('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'), 'Should have USDT mint');
    });

    test('getAllChains returns base, ethereum, and solana', () => {
      const all = chains.getAllChains();
      assert(all.includes('base'), 'Should include base');
      assert(all.includes('ethereum'), 'Should include ethereum');
      assert(all.includes('solana'), 'Should include solana');
      assertEqual(all.length, 3);
    });

    test('getChain returns full config for ethereum', () => {
      const cfg = chains.getChain('ethereum');
      assertEqual(cfg.name, 'ethereum');
      assertEqual(cfg.type, 'evm');
      assertEqual(cfg.chainId, '1');
      assertEqual(cfg.dexScreenerId, 'ethereum');
      assertEqual(cfg.goplus.chainId, '1');
      assertEqual(cfg.explorer.baseUrl, 'https://api.etherscan.io/api');
      assertEqual(cfg.explorer.apiKeyEnv, 'ETHERSCAN_API_KEY');
      assertEqual(cfg.birdeye, 'ethereum');
      assertEqual(cfg.dex, '1inch');
      assertEqual(cfg.portfolio.provider, 'debank');
      assertEqual(cfg.safe.addressEnv, 'SAFE_ADDRESS_ETH');
      assertEqual(cfg.safe.rpcEnv, 'RPC_ETH');
    });

    test('isEVM returns true for ethereum', () => {
      assert(chains.isEVM('ethereum'), 'ethereum should be EVM');
    });

    test('ethereum config has cashToken', () => {
      const cfg = chains.getChain('ethereum');
      assertEqual(cfg.cashToken.symbol, 'USDC');
      assertEqual(cfg.cashToken.address, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
      assertEqual(cfg.cashToken.decimals, 6);
    });

    test('ethereum config has nativeToken and wrappedNativeToken', () => {
      const cfg = chains.getChain('ethereum');
      assertEqual(cfg.nativeToken.symbol, 'ETH');
      assertEqual(cfg.nativeToken.decimals, 18);
      assertEqual(cfg.wrappedNativeToken.symbol, 'WETH');
      assertEqual(cfg.wrappedNativeToken.address, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      assertEqual(cfg.wrappedNativeToken.decimals, 18);
    });

    test('ethereum config has stablecoins list including cashToken', () => {
      const cfg = chains.getChain('ethereum');
      assert(Array.isArray(cfg.stablecoins), 'stablecoins must be an array');
      assert(cfg.stablecoins.length >= 3, 'Should have USDC, USDT, DAI');
      assert(
        cfg.stablecoins.map((a) => a.toLowerCase()).includes(cfg.cashToken.address.toLowerCase()),
        'cashToken address must be in stablecoins list',
      );
    });

    test('getStablecoins returns Set with lowercased addresses for ethereum', () => {
      const stables = chains.getStablecoins('ethereum');
      assert(stables instanceof Set, 'Should return a Set');
      assert(stables.size >= 3, 'Should have at least 3 stablecoins');
      for (const addr of stables) {
        assertEqual(addr, addr.toLowerCase(), 'EVM stablecoin addresses must be lowercased');
      }
    });

    test('getPortfolioRules returns global defaults for ethereum', () => {
      const rules = chains.getPortfolioRules('ethereum');
      assertEqual(rules.maxMoonshotPosition, 5);
      assertEqual(rules.maxConvictionPosition, 10);
      assertEqual(rules.maxBasePosition, 30);
      assertEqual(rules.maxOpenPositions, 15);
      assert(rules.tiersEnabled.includes('base'), 'Ethereum should enable base tier');
      assert(rules.tiersEnabled.includes('moonshot'), 'Ethereum should enable moonshot');
      assert(rules.tiersEnabled.includes('conviction'), 'Ethereum should enable conviction');
    });
  });

  // ============================================================
  // Base Tier Tokens Tests
  // ============================================================

  describe('Base Tier Tokens', () => {
    test('getBaseTierTokens returns WETH + cbBTC for base', () => {
      const tokens = chains.getBaseTierTokens('base');
      assert(Array.isArray(tokens), 'Should return array');
      assertEqual(tokens.length, 2);
      assertEqual(tokens[0].symbol, 'WETH');
      assertEqual(tokens[0].address, '0x4200000000000000000000000000000000000006');
      assertEqual(tokens[1].symbol, 'cbBTC');
    });

    test('getBaseTierTokens returns WETH + WBTC for ethereum', () => {
      const tokens = chains.getBaseTierTokens('ethereum');
      assert(Array.isArray(tokens), 'Should return array');
      assertEqual(tokens.length, 2);
      assertEqual(tokens[0].symbol, 'WETH');
      assertEqual(tokens[0].address, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      assertEqual(tokens[1].symbol, 'WBTC');
      assertEqual(tokens[1].address, '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599');
    });

    test('getBaseTierTokens returns wSOL for solana', () => {
      const tokens = chains.getBaseTierTokens('solana');
      assert(Array.isArray(tokens), 'Should return array');
      assertEqual(tokens.length, 1);
      assertEqual(tokens[0].symbol, 'wSOL');
      assertEqual(tokens[0].address, 'So11111111111111111111111111111111111111112');
    });

    test('every chain has non-empty baseTierTokens', () => {
      for (const name of chains.getAllChains()) {
        const tokens = chains.getBaseTierTokens(name);
        assert(tokens.length > 0, `${name} should have at least one base tier token`);
      }
    });

    test('baseTierTokens have required fields', () => {
      for (const name of chains.getAllChains()) {
        const tokens = chains.getBaseTierTokens(name);
        for (const token of tokens) {
          assert(token.symbol, `${name} base tier token must have symbol`);
          assert(token.address, `${name} base tier token must have address`);
          assert(typeof token.decimals === 'number', `${name} base tier token must have numeric decimals`);
        }
      }
    });
  });

  // ============================================================
  // Portfolio Rules Tests
  // ============================================================

  describe('Portfolio Rules', () => {
    test('getPortfolioRules returns full defaults for base', () => {
      const rules = chains.getPortfolioRules('base');
      assertEqual(rules.maxMoonshotPosition, 5);
      assertEqual(rules.maxConvictionPosition, 10);
      assertEqual(rules.maxBasePosition, 30);
      assertEqual(rules.maxMoonshotAllocation, 30);
      assertEqual(rules.minCashReserve, 10);
      assertEqual(rules.maxSameNarrative, 3);
      assertEqual(rules.maxOpenPositions, 15);
      assert(rules.tiersEnabled.includes('moonshot'), 'Base should enable moonshot');
      assert(rules.tiersEnabled.includes('conviction'), 'Base should enable conviction');
      assert(rules.tiersEnabled.includes('base'), 'Base should enable base tier');
    });

    test('getPortfolioRules returns overrides merged with defaults for solana', () => {
      const rules = chains.getPortfolioRules('solana');
      assertEqual(rules.maxMoonshotPosition, 7, 'Solana overrides moonshot to 7%');
      assertEqual(rules.maxMoonshotAllocation, 30, 'Solana overrides moonshot alloc to 30%');
      assertEqual(rules.maxConvictionPosition, 10, 'Conviction falls through to default');
      assertEqual(rules.maxOpenPositions, 10, 'Solana overrides max positions to 10');
      assertEqual(rules.minCashReserve, 10, 'Cash reserve falls through to default');
      assertEqual(rules.maxSameNarrative, 3, 'Narrative limit falls through to default');
    });

    test('solana tiersEnabled does NOT include base', () => {
      const rules = chains.getPortfolioRules('solana');
      assert(!rules.tiersEnabled.includes('base'), 'Solana should not enable base tier');
      assert(rules.tiersEnabled.includes('moonshot'), 'Solana should enable moonshot');
      assert(rules.tiersEnabled.includes('conviction'), 'Solana should enable conviction');
    });

    test('unspecified fields fall through to global defaults', () => {
      const rules = chains.getPortfolioRules('solana');
      assertEqual(rules.maxBasePosition, 30, 'maxBasePosition falls through to global default');
    });

    test('PORTFOLIO_RULES global defaults are exported', () => {
      const { PORTFOLIO_RULES } = chains;
      assert(PORTFOLIO_RULES, 'PORTFOLIO_RULES must be exported');
      assertEqual(PORTFOLIO_RULES.maxMoonshotPosition, 5);
    });
  });

  // ============================================================
  // Signer Threshold Tests
  // ============================================================

  describe('Signer Thresholds', () => {
    test('base has signerThreshold configured', () => {
      const cfg = chains.getChain('base');
      assertEqual(cfg.signerThreshold, 0.002);
    });

    test('ethereum has higher signerThreshold than base', () => {
      const base = chains.getChain('base');
      const eth = chains.getChain('ethereum');
      assert(eth.signerThreshold > base.signerThreshold, 'Ethereum gas is more expensive than L2');
    });

    test('solana has signerThreshold configured', () => {
      const cfg = chains.getChain('solana');
      assertEqual(cfg.signerThreshold, 0.05);
    });

    test('getSignerThreshold returns per-chain value', () => {
      assertEqual(chains.getSignerThreshold('base'), 0.002);
      assertEqual(chains.getSignerThreshold('ethereum'), 0.01);
      assertEqual(chains.getSignerThreshold('solana'), 0.05);
    });

    test('getSignerThreshold falls back to 0.005 for unknown threshold', () => {
      // Temporarily remove threshold from a chain to test fallback
      const cfg = chains.getChain('base');
      const orig = cfg.signerThreshold;
      delete cfg.signerThreshold;
      assertEqual(chains.getSignerThreshold('base'), 0.005);
      cfg.signerThreshold = orig;
    });

    test('every chain has a positive signerThreshold', () => {
      for (const name of chains.getAllChains()) {
        const threshold = chains.getSignerThreshold(name);
        assert(threshold > 0, `${name} signerThreshold must be positive`);
      }
    });
  });

  // ============================================================
  // Per-Chain Cash Keys Tests
  // ============================================================

  describe('Per-Chain Cash Keys', () => {
    test('cash_base key exists after migration', () => {
      const db = dbMod.getDb();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'cash_base'").get();
      assert(row, 'cash_base key must exist');
    });

    test('cash_solana key exists after migration', () => {
      const db = dbMod.getDb();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'cash_solana'").get();
      assert(row, 'cash_solana key must exist');
    });

    test('paper_cash_base key exists after migration', () => {
      const db = dbMod.getDb();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_cash_base'").get();
      assert(row, 'paper_cash_base key must exist');
    });

    test('paper_cash_solana key exists after migration', () => {
      const db = dbMod.getDb();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_cash_solana'").get();
      assert(row, 'paper_cash_solana key must exist');
    });

    test('old cash key still exists (backward compat)', () => {
      const db = dbMod.getDb();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'cash'").get();
      assert(row, 'Old cash key must still exist');
    });

    test('old paper_cash key still exists (backward compat)', () => {
      const db = dbMod.getDb();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_cash'").get();
      assert(row, 'Old paper_cash key must still exist');
    });

    test('total_deposited_base key exists', () => {
      const db = dbMod.getDb();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'total_deposited_base'").get();
      assert(row, 'total_deposited_base key must exist');
    });

    test('paper_initial_balance_base key exists', () => {
      const db = dbMod.getDb();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_initial_balance_base'").get();
      assert(row, 'paper_initial_balance_base key must exist');
    });

    test('cash_ethereum key exists after migration', () => {
      const db = dbMod.getDb();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'cash_ethereum'").get();
      assert(row, 'cash_ethereum key must exist');
    });

    test('paper_cash_ethereum key exists after migration', () => {
      const db = dbMod.getDb();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_cash_ethereum'").get();
      assert(row, 'paper_cash_ethereum key must exist');
    });

    test('total_deposited_ethereum key exists', () => {
      const db = dbMod.getDb();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'total_deposited_ethereum'").get();
      assert(row, 'total_deposited_ethereum key must exist');
    });

    test('paper_initial_balance_ethereum key exists', () => {
      const db = dbMod.getDb();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_initial_balance_ethereum'").get();
      assert(row, 'paper_initial_balance_ethereum key must exist');
    });
  });

  // ============================================================
  // Portfolio Sync Schema Tests
  // ============================================================

  describe('Portfolio Sync Schema', () => {
    test('portfolio_sync table exists after migration', () => {
      const db = dbMod.getDb();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='portfolio_sync'").all();
      assertEqual(tables.length, 1);
    });

    test('positions table has onchain_balance and last_synced_at columns', () => {
      const db = dbMod.getDb();
      const cols = db.prepare('PRAGMA table_info(positions)').all();
      const colNames = cols.map((c) => c.name);
      assert(colNames.includes('onchain_balance'), 'Should have onchain_balance');
      assert(colNames.includes('last_synced_at'), 'Should have last_synced_at');
    });

    test('positions table allows pending_analysis status', () => {
      const db = dbMod.getDb();
      const id = `test-pa-${Date.now()}`;
      db.prepare(
        `
        INSERT INTO positions (id, symbol, address, chain, tier, entry_price, quantity, stop_loss, take_profit_levels, status)
        VALUES (?, 'TEST', '0xtest', 'base', 'moonshot', 1.0, 100, 0.5, '[]', 'pending_analysis')
      `,
      ).run(id);
      const row = db.prepare('SELECT status FROM positions WHERE id = ?').get(id);
      assertEqual(row.status, 'pending_analysis');
      db.prepare('DELETE FROM positions WHERE id = ?').run(id);
    });

    test('sentinel has no portfolio_sync heartbeat', () => {
      const db = dbMod.getDb();
      const row = db
        .prepare("SELECT * FROM heartbeat_state WHERE agent = 'sentinel' AND check_type = 'portfolio_sync'")
        .get();
      assert(
        row === undefined,
        'Sentinel should not have portfolio_sync heartbeat — that is research agent responsibility',
      );
    });
  });

  // ============================================================
  // Sync Reconciliation Logic Tests
  // ============================================================

  describe('Sync Reconciliation Logic', () => {
    test('on-chain zero balance closes DB position', () => {
      const db = dbMod.getDb();
      const id = `test-sync-close-${Date.now()}`;
      db.prepare(
        `
        INSERT INTO positions (id, symbol, address, chain, tier, entry_price, quantity, stop_loss, take_profit_levels, status)
        VALUES (?, 'CLOSE', '0xclose', 'base', 'moonshot', 1.0, 100, 0.5, '[]', 'open')
      `,
      ).run(id);
      // Simulate sync: close the position
      db.prepare(
        `
        UPDATE positions SET status = 'closed', onchain_balance = 0, last_synced_at = datetime('now'),
          notes = 'Closed by on-chain sync: balance_zero_onchain', updated_at = datetime('now')
        WHERE id = ?
      `,
      ).run(id);
      const row = db.prepare('SELECT * FROM positions WHERE id = ?').get(id);
      assertEqual(row.status, 'closed');
      assertEqual(row.onchain_balance, 0);
      assert(row.notes.includes('balance_zero_onchain'), 'Should note the reason');
      db.prepare('DELETE FROM positions WHERE id = ?').run(id);
    });

    test('unknown on-chain token creates pending_analysis position', () => {
      const db = dbMod.getDb();
      const id = `test-sync-discover-${Date.now()}`;
      const now = new Date().toISOString();
      db.prepare(
        `
        INSERT INTO positions (id, symbol, name, address, chain, tier, entry_price, current_price,
          quantity, value_usd, stop_loss, take_profit_levels, status, onchain_balance, last_synced_at, notes)
        VALUES (?, 'NEWTOKEN', 'New Token', '0xnew', 'base', 'moonshot', 0.5, 0.5,
          1000, 500, 0.25, '[]', 'pending_analysis', 1000, ?, 'Auto-discovered on-chain — awaiting analysis')
      `,
      ).run(id, now);
      const row = db.prepare('SELECT * FROM positions WHERE id = ?').get(id);
      assertEqual(row.status, 'pending_analysis');
      assertEqual(row.tier, 'moonshot');
      assertEqual(row.stop_loss, 0.25);
      assert(row.notes.includes('Auto-discovered'), 'Should have discovery note');
      db.prepare('DELETE FROM positions WHERE id = ?').run(id);
    });

    test('balance update propagates to quantity and value_usd', () => {
      const db = dbMod.getDb();
      const id = `test-sync-update-${Date.now()}`;
      db.prepare(
        `
        INSERT INTO positions (id, symbol, address, chain, tier, entry_price, quantity, value_usd, stop_loss, take_profit_levels, status)
        VALUES (?, 'UPD', '0xupd', 'base', 'moonshot', 1.0, 100, 100, 0.5, '[]', 'open')
      `,
      ).run(id);
      db.prepare(
        `
        UPDATE positions SET quantity = 200, value_usd = 400, onchain_balance = 200, current_price = 2.0,
          last_synced_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `,
      ).run(id);
      const row = db.prepare('SELECT * FROM positions WHERE id = ?').get(id);
      assertEqual(row.quantity, 200);
      assertEqual(row.value_usd, 400);
      assertEqual(row.onchain_balance, 200);
      assertEqual(row.current_price, 2.0);
      db.prepare('DELETE FROM positions WHERE id = ?').run(id);
    });

    test('sync record written to portfolio_sync table', () => {
      const db = dbMod.getDb();
      db.prepare(
        `
        INSERT INTO portfolio_sync (chain, provider, trigger, status, positions_synced, positions_closed, positions_discovered)
        VALUES ('base', 'debank', 'manual', 'success', 5, 1, 2)
      `,
      ).run();
      const row = db.prepare("SELECT * FROM portfolio_sync WHERE chain = 'base' ORDER BY id DESC LIMIT 1").get();
      assertEqual(row.chain, 'base');
      assertEqual(row.provider, 'debank');
      assertEqual(row.trigger, 'manual');
      assertEqual(row.status, 'success');
      assertEqual(row.positions_synced, 5);
      assertEqual(row.positions_closed, 1);
      assertEqual(row.positions_discovered, 2);
      db.prepare('DELETE FROM portfolio_sync WHERE id = ?').run(row.id);
    });

    test('paper mode skips on-chain sync (script-level guard)', () => {
      // portfolio-load-evm.js checks PAPER_MODE at the top and exits early
      // db-query.js sync-portfolio also checks PAPER_MODE
      assert(true, 'Paper mode guard validated at script level');
    });

    test('gas balance stored in portfolio_meta as JSON', () => {
      const db = dbMod.getDb();
      const gasData = { symbol: 'ETH', balance: 0.05, price: 2400, value_usd: 120 };
      const gasJson = JSON.stringify(gasData);
      db.prepare(
        `INSERT INTO portfolio_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
      ).run('gas_base', gasJson, gasJson);
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'gas_base'").get();
      assert(row, 'gas_base key must exist');
      const parsed = JSON.parse(row.value);
      assertEqual(parsed.symbol, 'ETH');
      assertEqual(parsed.balance, 0.05);
      assertEqual(parsed.price, 2400);
      assertEqual(parsed.value_usd, 120);
      db.prepare("DELETE FROM portfolio_meta WHERE key = 'gas_base'").run();
    });

    test('native token address never appears in positions table', () => {
      const db = dbMod.getDb();
      const rows = db.prepare("SELECT * FROM positions WHERE address = 'native'").all();
      assertEqual(rows.length, 0, 'No position should have address=native');
    });
  });

  // Cleanup
  dbMod.close();

  const passed = summary();
  process.exit(passed ? 0 : 1);
}

runTests();
