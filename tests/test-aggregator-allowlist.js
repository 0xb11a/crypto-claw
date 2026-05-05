#!/usr/bin/env node
/**
 * Test Suite: Aggregator Router Allowlist (PR 2.3)
 *
 * Defangs threat #13. If 1inch / Jupiter has its API or DNS
 * compromised, the response could redirect tx.to / programId at an
 * attacker contract — and with maxUint256 USDC approvals already
 * granted (until PR 2.5 scopes them down) that's a one-tx wallet
 * drain. We hard-allowlist the known-good routers/programs.
 *
 * This suite tests the pure helpers in chains.js + the Solana
 * instruction validator. Spawn-level tests live in the network suite.
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import { isAllowedRouter, isAllowedSwapProgram, isAllowedAncillaryProgram, getAggregator } from '../scripts/chains.js';
import { validateJupiterInstructions } from '../scripts/execute-trade-solana.js';

// Real, well-known constants from the production allowlists.
const ONEINCH_V6 = '0x111111125421cA6dc452d289314280a0f8842A65';
const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const ATTACKER_PROGRAM = 'AAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ATTACKER_EVM = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

describe('getAggregator() — chain-keyed config', () => {
  test('base returns 1inch-v6 config', () => {
    const a = getAggregator('base');
    assertEqual(a.name, '1inch-v6');
    assert(Array.isArray(a.routerAllowlist), 'routerAllowlist is array');
  });

  test('ethereum shares the EVM aggregator config', () => {
    assertEqual(getAggregator('ethereum').name, '1inch-v6');
  });

  test('solana returns jupiter-v6 config', () => {
    const a = getAggregator('solana');
    assertEqual(a.name, 'jupiter-v6');
    assert(Array.isArray(a.swapProgramAllowlist));
    assert(Array.isArray(a.ancillaryProgramAllowlist));
  });
});

describe('isAllowedRouter() — EVM tx.to validation', () => {
  test('canonical 1inch v6 is allowed on base', () => {
    assertEqual(isAllowedRouter('base', ONEINCH_V6), true);
  });

  test('canonical 1inch v6 is allowed on ethereum (same router)', () => {
    assertEqual(isAllowedRouter('ethereum', ONEINCH_V6), true);
  });

  test('lowercase form is allowed (case-insensitive)', () => {
    assertEqual(isAllowedRouter('base', ONEINCH_V6.toLowerCase()), true);
  });

  test('uppercase form is allowed', () => {
    assertEqual(isAllowedRouter('base', ONEINCH_V6.toUpperCase()), true);
  });

  test('attacker address is REJECTED', () => {
    assertEqual(isAllowedRouter('base', ATTACKER_EVM), false);
  });

  test('1inch v5 (not in allowlist) is REJECTED', () => {
    // Old router — should NOT pass since we only allow v6.
    assertEqual(isAllowedRouter('base', '0x1111111254EEB25477B68fb85Ed929f73A960582'), false);
  });

  test('null/empty/non-string rejected', () => {
    assertEqual(isAllowedRouter('base', null), false);
    assertEqual(isAllowedRouter('base', ''), false);
    assertEqual(isAllowedRouter('base', undefined), false);
    assertEqual(isAllowedRouter('base', 12345), false);
  });

  test('Solana chain returns false (no EVM router)', () => {
    assertEqual(isAllowedRouter('solana', ONEINCH_V6), false);
  });
});

describe('isAllowedSwapProgram() — Solana programId validation', () => {
  test('Jupiter v6 is allowed on solana', () => {
    assertEqual(isAllowedSwapProgram('solana', JUPITER_V6), true);
  });

  test('attacker program is REJECTED', () => {
    assertEqual(isAllowedSwapProgram('solana', ATTACKER_PROGRAM), false);
  });

  test('System Program (allowed for ancillary) is NOT allowed as swap program', () => {
    assertEqual(isAllowedSwapProgram('solana', SYSTEM_PROGRAM), false);
  });

  test('null/empty rejected', () => {
    assertEqual(isAllowedSwapProgram('solana', null), false);
    assertEqual(isAllowedSwapProgram('solana', ''), false);
  });
});

describe('isAllowedAncillaryProgram() — setup/cleanup validation', () => {
  test('System Program allowed', () => {
    assertEqual(isAllowedAncillaryProgram('solana', SYSTEM_PROGRAM), true);
  });

  test('SPL Token Program allowed', () => {
    assertEqual(isAllowedAncillaryProgram('solana', SPL_TOKEN), true);
  });

  test('ATA Program allowed', () => {
    assertEqual(isAllowedAncillaryProgram('solana', ATA_PROGRAM), true);
  });

  test('Jupiter v6 also allowed in ancillary slots (sometimes used in cleanup)', () => {
    assertEqual(isAllowedAncillaryProgram('solana', JUPITER_V6), true);
  });

  test('attacker program REJECTED in ancillary slots', () => {
    assertEqual(isAllowedAncillaryProgram('solana', ATTACKER_PROGRAM), false);
  });
});

describe('validateJupiterInstructions() — full Jupiter response', () => {
  function legitSwapData() {
    return {
      swapInstruction: { programId: JUPITER_V6, accounts: [], data: '' },
      setupInstructions: [
        { programId: ATA_PROGRAM, accounts: [], data: '' },
        { programId: SYSTEM_PROGRAM, accounts: [], data: '' },
      ],
      cleanupInstruction: { programId: SPL_TOKEN, accounts: [], data: '' },
    };
  }

  test('legitimate Jupiter response passes', () => {
    const r = validateJupiterInstructions(legitSwapData(), 'solana');
    assertEqual(r.valid, true);
  });

  test('missing swapInstruction REJECTED', () => {
    const r = validateJupiterInstructions({ swapInstruction: null }, 'solana');
    assertEqual(r.valid, false);
    assert(r.reason.includes('missing_swap_instruction_programId'));
  });

  test('attacker programId in swapInstruction REJECTED', () => {
    const data = legitSwapData();
    data.swapInstruction.programId = ATTACKER_PROGRAM;
    const r = validateJupiterInstructions(data, 'solana');
    assertEqual(r.valid, false);
    assert(r.reason.includes('swap_program_not_allowlisted'));
    assert(r.reason.includes(ATTACKER_PROGRAM));
  });

  test('attacker programId in setupInstructions REJECTED', () => {
    const data = legitSwapData();
    data.setupInstructions[0].programId = ATTACKER_PROGRAM;
    const r = validateJupiterInstructions(data, 'solana');
    assertEqual(r.valid, false);
    assert(r.reason.includes('ancillary_program_not_allowlisted'));
  });

  test('attacker programId in cleanupInstruction REJECTED', () => {
    const data = legitSwapData();
    data.cleanupInstruction.programId = ATTACKER_PROGRAM;
    const r = validateJupiterInstructions(data, 'solana');
    assertEqual(r.valid, false);
    assert(r.reason.includes('ancillary_program_not_allowlisted'));
  });

  test('no setup/cleanup instructions still passes (just the swap)', () => {
    const r = validateJupiterInstructions(
      { swapInstruction: { programId: JUPITER_V6, accounts: [], data: '' } },
      'solana',
    );
    assertEqual(r.valid, true);
  });

  test('setupInstruction missing programId REJECTED', () => {
    const data = legitSwapData();
    data.setupInstructions[0] = { accounts: [], data: '' }; // no programId
    const r = validateJupiterInstructions(data, 'solana');
    assertEqual(r.valid, false);
    assert(r.reason.includes('missing_programId'));
  });
});

process.exit(summary() ? 0 : 1);
