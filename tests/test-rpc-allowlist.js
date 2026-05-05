#!/usr/bin/env node
/**
 * Test Suite: RPC Hostname Allowlist (PR 2.8)
 *
 * Defangs threat #14 (compromised RPC env var). If RPC_BASE /
 * RPC_SOL / RPC_ETH is tampered to point at an attacker-controlled
 * node, the attacker can:
 *   - snoop signed-tx broadcast (front-run)
 *   - drop txs (censor before broadcast)
 *   - return manipulated state reads (fake balance → bypass PR 2.4
 *     cash reconciliation)
 *
 * PR 2.8 hashes the resolved RPC hostname against a per-chain
 * allowlist (exact + suffix match). Wired into execute-trade-{evm,
 * solana}.js AND onchain-balance.js for defense-in-depth.
 */

import { describe, test, assertEqual, summary } from './test-helpers.js';
import { isAllowedRpcUrl } from '../scripts/chains.js';

describe('isAllowedRpcUrl() — exact match', () => {
  test('mainnet.base.org allowed on base', () => {
    assertEqual(isAllowedRpcUrl('base', 'https://mainnet.base.org'), true);
  });

  test('cloudflare-eth.com allowed on ethereum', () => {
    assertEqual(isAllowedRpcUrl('ethereum', 'https://cloudflare-eth.com'), true);
  });

  test('api.mainnet-beta.solana.com allowed on solana', () => {
    assertEqual(isAllowedRpcUrl('solana', 'https://api.mainnet-beta.solana.com'), true);
  });

  test('case-insensitive on hostname', () => {
    assertEqual(isAllowedRpcUrl('base', 'https://MAINNET.BASE.ORG/'), true);
  });
});

describe('isAllowedRpcUrl() — suffix match (per-API-key subdomains)', () => {
  test('Alchemy with API-key subdomain on base', () => {
    assertEqual(isAllowedRpcUrl('base', 'https://base-mainnet.g.alchemy.com/v2/abc123def456'), true); // pre-commit-allow
  });

  test('Alchemy with API-key subdomain on ethereum', () => {
    assertEqual(isAllowedRpcUrl('ethereum', 'https://eth-mainnet.g.alchemy.com/v2/xyz'), true); // pre-commit-allow
  });

  test('Helius with API key on solana', () => {
    assertEqual(isAllowedRpcUrl('solana', 'https://mainnet.helius-rpc.com/?api-key=abc'), true); // pre-commit-allow
  });

  test('Infura with project ID on ethereum', () => {
    assertEqual(isAllowedRpcUrl('ethereum', 'https://mainnet.infura.io/v3/projectid123'), true); // pre-commit-allow
  });

  test('PublicNode on base', () => {
    assertEqual(isAllowedRpcUrl('base', 'https://base-rpc.publicnode.com'), true);
  });

  test('Ankr on solana', () => {
    assertEqual(isAllowedRpcUrl('solana', 'https://rpc.ankr.com/solana/api-key'), true); // pre-commit-allow
  });
});

describe('isAllowedRpcUrl() — REJECTED hosts', () => {
  test('attacker.example.com rejected on base', () => {
    assertEqual(isAllowedRpcUrl('base', 'https://attacker.example.com'), false);
  });

  test('lookalike "alchemy.com.evil.io" rejected (suffix attack)', () => {
    // Suffix match is on "alchemy.com" — lookalike hostname ending in
    // ".evil.io" must NOT pass even if it contains "alchemy.com"
    // somewhere in the middle.
    assertEqual(isAllowedRpcUrl('base', 'https://alchemy.com.evil.io'), false);
  });

  test('localhost rejected (would leak local state)', () => {
    assertEqual(isAllowedRpcUrl('base', 'http://localhost:8545'), false);
  });

  test('private IP rejected', () => {
    assertEqual(isAllowedRpcUrl('base', 'http://192.168.1.100:8545'), false);
  });

  test('Solana RPC submitted as base RPC (cross-chain confusion) rejected', () => {
    assertEqual(isAllowedRpcUrl('base', 'https://api.mainnet-beta.solana.com'), false);
  });

  test('EVM RPC submitted as solana RPC rejected', () => {
    assertEqual(isAllowedRpcUrl('solana', 'https://mainnet.base.org'), false);
  });
});

describe('isAllowedRpcUrl() — malformed input', () => {
  test('null rejected', () => {
    assertEqual(isAllowedRpcUrl('base', null), false);
  });

  test('empty string rejected', () => {
    assertEqual(isAllowedRpcUrl('base', ''), false);
  });

  test('undefined rejected', () => {
    assertEqual(isAllowedRpcUrl('base', undefined), false);
  });

  test('non-string rejected', () => {
    assertEqual(isAllowedRpcUrl('base', 12345), false);
  });

  test('not a URL rejected', () => {
    assertEqual(isAllowedRpcUrl('base', 'this is not a url'), false);
  });

  test('URL without hostname rejected', () => {
    assertEqual(isAllowedRpcUrl('base', 'data:text/plain,foo'), false);
  });
});

describe('isAllowedRpcUrl() — unknown chain', () => {
  test('unknown chain returns false (fail-closed)', () => {
    assertEqual(isAllowedRpcUrl('mars', 'https://mainnet.base.org'), false);
  });
});

describe('PR 2.8 — adversarial fixtures', () => {
  test('attacker hostname with legit subdomain prefix rejected', () => {
    // attacker.helius-rpc.com.evil.io has hostname ending in
    // .evil.io, not .helius-rpc.com — should reject.
    assertEqual(isAllowedRpcUrl('solana', 'https://attacker.helius-rpc.com.evil.io'), false);
  });

  test('legit-looking but unknown TLD rejected', () => {
    assertEqual(isAllowedRpcUrl('base', 'https://base-mainnet.g.alchemy.io'), false);
  });

  test('suffix-only-without-dot trick rejected', () => {
    // "fakealchemy.com" ends in "alchemy.com" but the suffix list
    // entry is ".alchemy.com" (with leading dot). Should reject.
    assertEqual(isAllowedRpcUrl('base', 'https://fakealchemy.com'), false);
  });
});

process.exit(summary() ? 0 : 1);
