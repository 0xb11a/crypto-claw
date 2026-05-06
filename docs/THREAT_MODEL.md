# THREAT_MODEL.md — CryptoClaw

**Audience:** developers and Claude sessions extending CryptoClaw. Read this before adding any feature that touches signing, the executor, or external data ingestion.

## What this system actually is, security-wise

- **Server-side, multisig-gated.** All value movement requires Safe (EVM) or Squads (Solana) co-sign. The executor holds one signer key in env-only memory; threshold ≥ 1.
- **Four LLM agents** consume external data (DEXScreener, GoPlus, Birdeye, Etherscan, Helius, Telegram, GitHub) and propose trades. The agents are an attack surface, not just the signing key.
- **No browser, no UI, no seed phrase.** Most consumer-wallet drainer vectors don't apply here.

The dominant risk is not the multisig — it's the LLM agents being tricked into proposing the wrong trade or poisoning shared memory.

## How to read this doc

Each row of the taxonomy below is one of the 30 standard "wallet drainer" vectors from [Axel Bitblaze's Top-30 list](https://x.com/axel_bitblaze69/status/2047254817173807519) ([archived analysis](../.claude/plans/lets-check-this-post-immutable-snail.md)) plus a few LLM-specific vectors that aren't in the consumer literature. For each:

- **Status:** `N/A` (architecture eliminates it), `mitigated by PR X.Y` (with file:function citation), `partial` (residual risk documented), or `accepted` (out-of-scope by design).
- **Verify:** how to confirm the mitigation still works.

If you're adding a feature that re-introduces an N/A vector (e.g. adding a browser, adding seed-phrase signing, adding bridges), update this doc in the same PR.

---

## Taxonomy

### Vectors that don't apply to crypto-claw

| # | Vector | Why N/A |
|---|---|---|
| 1 | Phishing sites / fake dApps | No browser, no dApp UI |
| 2 | Drainer deeplinks / WalletConnect URI hijack | No wallet UI; agents don't follow links |
| 3 | Seed-phrase exfiltration | No seed phrase. Multisig signer keys live in env vars only; `scripts/redact.js` strips them from every log path; `scripts/pre-commit-check.js` blocks commits containing key patterns |
| 5 | EIP-2612 / Permit2 abuse | Executor never signs permits, only Safe transactions |
| 20 | Bridge / wrong-chain confusion | No bridging logic; each chain has its own vault |

### Vectors mitigated by code

Listed in PR order so you can trace by phase. Plan reference: `/Users/aquila/.claude/plans/lets-check-this-post-immutable-snail.md`.

| # | Vector | Mitigation | Verify |
|---|---|---|---|
| 23 | **Prompt injection via token name/symbol** | PR 1.1: `sanitizeUntrusted()` in `scripts/redact.js`. PR 1.2: applied at every ingest boundary in `scan-tokens.js`, `token-metrics.js`, `check-wallets.js` | `tests/test-redact.js`, `tests/test-untrusted-rule.js` |
| 24 | Prompt injection via on-chain metadata | PR 1.2: same `sanitizeUntrusted()` applied to GoPlus / Birdeye / Etherscan responses | `tests/test-redact.js` |
| 25 | Prompt injection via Telegram message body | PR 1.6: untrusted-strings principle in all four `agents/*/AGENTS.md` Core Principles. Operator-side, semantic defense | `tests/test-untrusted-rule.js` |
| 26 | Prompt injection via GitHub issue body | PR 1.6: same principle in `agents/observer/AGENTS.md` Core Principle #5 | `tests/test-untrusted-rule.js` |
| 6 | Address poisoning (lookalikes, RTL, zero-width) | PR 1.3: `scripts/address-validator.js` — viem `getAddress()` (EVM checksum) + `@solana/web3.js` `PublicKey` (base58 length). Wired into all six ingest scripts | `tests/test-address-validator.js` |
| 7 | Fake / impersonator token CA | PR 1.3: same checksum validation at ingest catches non-canonical addresses before they enter the DB | `tests/test-address-validator.js` |
| 28 | **Tier-label forgery** | PR 1.4: `validateTier()` in `scripts/process-order.js` schema-validates against `chains.js` `tiersEnabled`. Migration 027 cleans existing bad rows | `tests/test-tier-validation.js` |
| 30 | **`AUTO_APPROVE_BUY=true` + prompt injection** | PR 1.5: `scripts/order-approval.js` `determineOrderApproval()`. Requires `AUTO_APPROVE_BUY_MAX_USD` cap; `entrypoint.sh` fails closed at boot if missing | `tests/test-auto-approve-cap.js` |
| 29 | Cash-balance poisoning (`portfolio_meta.cash_*`) | PR 2.1: `validateAmountCap()` in `process-order.js` enforces per-tier absolute USD ceilings (default $200/$500/$2000). PR 2.4: `evaluateCashDrift()` reconciles DB vs on-chain Safe/Squads balance pre-execute | `tests/test-tier-amount-cap.js`, `tests/test-cash-reconcile.js` |
| 8 | Honeypot tokens (post-proposal activation) | PR 2.2: `recheckBuySafety()` re-runs `check-contract.js` immediately before signing. Refuses on `is_honeypot` regardless of Research's earlier verdict | `tests/test-presign-recheck.js` |
| 9 | Pausable / blacklist contracts (post-proposal) | PR 2.2: same recheck refuses on `transfer_pausable` / `is_blacklisted` | `tests/test-presign-recheck.js` |
| 10 | Top-holder concentration > 30% | PR 2.2: recheck filters non-locked non-contract holders, refuses if first real holder > 30%. Locked LP and contract holders excluded (legitimate at high concentration) | `tests/test-presign-recheck.js` |
| 13 | **Compromised aggregator API → arbitrary `tx.to`** | PR 2.3: `isAllowedRouter()` (EVM 1inch v6 hardcoded), `isAllowedSwapProgram()` + `isAllowedAncillaryProgram()` (Solana Jupiter v6 + 5 system programs). Catches the subtle Solana variant where Jupiter's `setupInstructions` execute first under vault signing authority | `tests/test-aggregator-allowlist.js` |
| 4 | Ice phishing / unlimited approvals | PR 2.5: `computeApprovalAmount()` in `execute-trade-evm.js` — approves `quote_amount * 1.05` instead of `maxUint256`. Costs ~$3 gas/buy. **Operational caveat:** existing Safes that previously approved maxUint256 retain that approval — manually revoke via Safe UI to fully realize the benefit | `tests/test-scoped-approvals.js` |
| 16 | Fee-on-transfer / rebase / partial honeypot | PR 2.6: pre/post-swap balance snapshot in `execute-trade-{evm,solana}.js`. `evaluateReceivedDrift()` writes the actual received qty (not quoted) into `positions.quantity`. PR 3.3: `scripts/reconcile-positions.js` re-checks every open position hourly to catch CONTINUOUS drift (slow-bleed taxes, freeze-authority confiscation, dilution mints) | `tests/test-recv-drift.js`, `tests/test-position-reconcile.js` |
| 15 | Stale price / oracle manipulation | PR 2.7: `scripts/price-oracle.js` cross-checks aggregator quote against DEXScreener+Birdeye 2-of-2 (≤2% spread, ≤5% drift from quote). Pyth/Chainlink hooks stubbed; long-tail tokens use the 2-of-2 fallback | `tests/test-price-oracle.js` |
| 14 | **Compromised RPC node** | PR 2.8: `isAllowedRpcUrl()` in `chains.js` — exact + suffix match against per-chain provider allowlist (Alchemy, Infura, Helius, etc.). Suffix matching uses leading dots so `attacker.alchemy.com.evil.io` is correctly rejected. Modes via `RPC_VALIDATION_MODE`: strict / warn / skip | `tests/test-rpc-allowlist.js` |
| 27 | **Memory poisoning (`MEMORY.md`)** | PR 3.1: `scripts/promote-pattern.js` is the sole legitimate writer. Validates `--seen >= 3`, `--attestation-source` from a known skill set, and `--derived-from` IDs that exist in TRUSTED tables (receipts, positions, *_log — explicitly NOT tracked_wallets.notes / orders.reasoning / analysis_cache.token_data). `pre-commit-check.js` rejects manual edits without the provenance marker | `tests/test-promote-pattern.js` |
| 18 | Multisig owner / threshold drift | PR 3.2: `scripts/governance-drift.js` predicates + `--check-drift` flag on status scripts + daily `run_governance_drift_loop` cron. Fires `rug_warning` Telegram alert on owner-add, threshold-lower, or unexpected Safe module. Requires `EXPECTED_SAFE_OWNERS_<CHAIN>` / `EXPECTED_SAFE_THRESHOLD_<CHAIN>` / `EXPECTED_SQUADS_*` env vars set at fund setup | `tests/test-governance-drift.js` |
| 19 | Safe module / delegatecall exploit | PR 3.2: same drift cron asserts `modules ⊆ EXPECTED_SAFE_MODULES_<CHAIN>` (default empty). Module-add is the subtler variant — owner list looks clean — and the test specifically covers it | `tests/test-governance-drift.js` |
| 21 | Supply-chain (npm) attack | PR 3.4: `findUnacceptableVulns()` + `AUDIT_ALLOWLIST` (4 known transitive Solana-chain findings) in `pre-commit-check.js`. Fires `npm audit --audit-level=high --json` when `scripts/package-lock.json` is in the staged diff. `make audit` for explicit pre-bump review | `tests/test-audit-gate.js` |

### Phase 4 — additional defenses beyond the original 30

These vectors aren't in the consumer drainer literature but they're real for an automated trading system. Documenting them so the operator and future Claude know the mitigation is intentional.

| Risk | Mitigation | Verify |
|---|---|---|
| Buying brand-new tokens in the highest-rug-risk window | PR 4.1: `evaluateTokenAge()` in `process-order.js` quarantines real-mode buys for tokens younger than 24h (`QUARANTINE_TOKEN_AGE_HOURS` tunable). Surfaces in Research Telegram topic; operator can override via `approve-order` | `tests/test-quarantine-age.js` |
| Single-source token data (DEXScreener-only or Birdeye-only listings — concentrated rug risk) | PR 4.2: `evaluateTwoSourceConfirmation()` requires both sources to see the token AND agree on price within 2%. Quarantines on disagreement (signal of wash-trading) or single-source presence | `tests/test-two-source-confirm.js` |
| Agent prose drifts from code-enforced limits (e.g. someone weakens cash reserve in CLAUDE.md without touching `chains.js`) | PR 4.4: `findSafetyRuleMismatches()` in `pre-commit-check.js` parses CLAUDE.md "Safety Rules" section, compares to live `PORTFOLIO_RULES`. Fires when CLAUDE.md or chains.js is staged | `tests/test-safety-rule-drift.js`, `make check` |

### Vectors mitigated by architecture (no code change needed)

| # | Vector | Why already mitigated |
|---|---|---|
| 11 | Liquidity rug / removal | Sentinel polls `check-liquidity.js` every 15 min; CRITICAL severity writes sell-all order. Snapshot windowing (1h + 24h) catches slow bleeds the per-check delta misses |
| 17 | Signature/nonce replay | Safe nonce + Squads `transactionIndex` are protocol-level; no custom replay defense needed |
| 22 | Telegram bot impersonation | `entrypoint.sh:444-449` enforces `TELEGRAM_OWNER_ID` allowlist. `groupPolicy=allowlist` rejects non-allowlisted groups |

### Accepted residuals (intentional non-mitigations)

| Vector | Why accepted |
|---|---|
| 12 — Front-running / sandwich / MEV (within slippage cap) | Slippage cap (5% moonshot, 2% conviction/base) bounds the loss. Going further requires private mempool (Flashbots) or Jito bundles — high engineering cost, marginal benefit on the trade sizes we operate at. Revisit if average position grows past $5k |
| Long-tail tokens with no Birdeye listing | PR 4.2 quarantines these. Acceptable trade-off — the alternative is single-source data which is the higher risk |
| Long-tail tokens with no Pyth/Chainlink feed | PR 2.7 falls back to DEXScreener+Birdeye 2-of-2. Pyth/Chainlink hooks are stubs; only worth filling for majors (USDC/WETH/SOL) — moonshot universe is mostly long-tail anyway |
| Existing Safes' legacy maxUint256 approvals (pre-PR 2.5) | New approvals are scoped to `quote * 1.05`. Operator must manually revoke old approvals via the Safe UI to retroactively benefit |

## How to verify all mitigations are still in place

```bash
make test       # 36 offline test suites, ~580 individual assertions
```
```bash
make audit      # npm audit gate (PR 3.4)
```
```bash
make check      # CLAUDE.md ↔ chains.js drift gate (PR 4.4)
```

The pre-commit hook runs all three plus the secret scan, MEMORY.md provenance check, and lint/format gates. **A clean `git commit` is the verification.**

## When to update this doc

- Adding a new ingest boundary (script that fetches external data) → re-evaluate vectors 23/24, ensure `sanitizeUntrusted()` + `requireValidAddress()` are wired in.
- Adding a new agent or skill → check if any unconditional rules need to land in that agent's `AGENTS.md` Core Principles (Pass 11 of audit-instructions skill).
- Adding a new chain → confirm RPC allowlist (PR 2.8), aggregator allowlist (PR 2.3), governance expected-config env vars (PR 3.2), tier amount caps (PR 2.1), and safety-rule entry in CLAUDE.md (PR 4.4) all extend to it.
- Bumping `@solana/spl-token`, `@sqds/multisig`, or anything in the audit allowlist (PR 3.4) → check whether the upstream advisory is now fixed; remove from allowlist if so.
- Discovering a NEW threat vector not in this list → add a row to the appropriate section. The discipline is that an unmitigated vector either gets a mitigation PR or moves to "accepted residuals" with reasoning. Don't leave threat surface undocumented.
