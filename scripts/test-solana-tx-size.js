#!/usr/bin/env node
/**
 * test-solana-tx-size.js — Prove the LUT fix shrinks the Squads meta-tx.
 *
 * Reproduces the "$YzY" failure (VersionedTransaction too large: 1652 bytes)
 * by constructing a Jupiter-scale inner swap message, wrapping it in the
 * Squads meta-tx (vaultTransactionCreate + proposalCreate + proposalApprove),
 * and serializing with and without addressLookupTableAccounts.
 *
 * No RPC — all accounts are synthetic, AddressLookupTableAccount is built
 * in-process. Purely measures that vaultTransactionCreate respects the LUT
 * when wiring its inner v0 message, which is what keeps the meta-tx under
 * Solana's 1232-byte raw-transaction limit.
 */

import {
  PublicKey,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { describe, test, assert, summary } from '../tests/test-helpers.js';

const SOLANA_TX_LIMIT = 1232;

// Build a fake Jupiter-shaped swap instruction that references N accounts.
// 25 is representative of a multi-hop route — similar to what triggered the
// 1652-byte overflow in production.
function buildFakeJupiterSwap(numAccounts, vaultPda) {
  const accounts = [vaultPda, ...Array.from({ length: numAccounts - 1 }, () => Keypair.generate().publicKey)];
  const jupiterProgram = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  return {
    ix: new TransactionInstruction({
      programId: jupiterProgram,
      keys: accounts.map((pubkey, i) => ({
        pubkey,
        isSigner: i === 0,
        isWritable: i < 3,
      })),
      // Jupiter's swap instruction data is ~40-80 bytes for typical routes
      data: Buffer.alloc(64, 0x42),
    }),
    accounts,
  };
}

// Construct an in-memory LUT that contains all routing accounts.
// Real Jupiter LUTs are fetched from chain; for this test we only need the
// shape (key + state.addresses) that vaultTransactionCreate consumes when
// compiling the inner v0 message.
function buildLookupTable(addresses) {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt('0xffffffffffffffff'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses,
    },
  });
}

// Fixed scenario so both measurements run against the same accounts + LUT.
function buildScenario() {
  const multisigPda = Keypair.generate().publicKey;
  const vaultPda = Keypair.generate().publicKey;
  const signer = Keypair.generate();
  const { ix: swapIx, accounts: routeAccounts } = buildFakeJupiterSwap(25, vaultPda);
  return { multisigPda, vaultPda, signer, swapIx, routeAccounts };
}

function buildMetaTx(scenario, { lookupTableAccounts }) {
  const { multisigPda, vaultPda, signer, swapIx } = scenario;
  const transactionIndexBN = 42n;
  const blockhash = '11111111111111111111111111111111';

  const innerMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: blockhash,
    instructions: [swapIx],
  });

  const createTxIx = multisig.instructions.vaultTransactionCreate({
    multisigPda,
    transactionIndex: transactionIndexBN,
    creator: signer.publicKey,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage: innerMessage,
    addressLookupTableAccounts: lookupTableAccounts,
  });

  const createProposalIx = multisig.instructions.proposalCreate({
    multisigPda,
    transactionIndex: transactionIndexBN,
    creator: signer.publicKey,
  });

  const approveIx = multisig.instructions.proposalApprove({
    multisigPda,
    transactionIndex: transactionIndexBN,
    member: signer.publicKey,
  });

  const metaMessage = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions: [createTxIx, createProposalIx, approveIx],
  }).compileToV0Message();

  const metaTx = new VersionedTransaction(metaMessage);
  metaTx.sign([signer]);

  return { size: metaTx.serialize().length };
}

describe('Squads meta-tx size — reproduces $YzY overflow and proves LUT fix', () => {
  // Same accounts in both builds — the only difference is whether the LUT is
  // passed into vaultTransactionCreate.
  const scenario = buildScenario();
  const lut = buildLookupTable(scenario.routeAccounts);
  const noLut = buildMetaTx(scenario, { lookupTableAccounts: [] });
  const withLut = buildMetaTx(scenario, { lookupTableAccounts: [lut] });

  console.log(`    meta-tx without LUTs: ${noLut.size} bytes`);
  console.log(`    meta-tx with    LUTs: ${withLut.size} bytes`);
  console.log(`    Solana raw-tx limit:  ${SOLANA_TX_LIMIT} bytes`);
  console.log(`    savings:              ${noLut.size - withLut.size} bytes`);

  test('without LUTs, 25-account swap overflows the 1232-byte limit (reproduces $YzY)', () => {
    assert(noLut.size > SOLANA_TX_LIMIT, `expected > ${SOLANA_TX_LIMIT} to prove overflow, got ${noLut.size}`);
  });

  test('with LUTs, same swap fits under 1232 bytes (proves the fix)', () => {
    assert(
      withLut.size <= SOLANA_TX_LIMIT,
      `expected <= ${SOLANA_TX_LIMIT} after LUT compression, got ${withLut.size}`,
    );
  });

  test('LUTs save at least 500 bytes on a 25-account route', () => {
    const saved = noLut.size - withLut.size;
    assert(saved >= 500, `expected >= 500 bytes saved, got ${saved}`);
  });
});

summary();
