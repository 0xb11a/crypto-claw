# HEARTBEAT.md — Sentinel Agent

## Schedule
Sentinel heartbeat runs every 15 minutes. Most checks run every heartbeat (price, liquidity, wallet, smart-money exits). Contract check is rotating (≈ every 30 min) — gated by `cclaw heartbeat overdue` in Step 5.
Keep checks fast and mechanical.

> **Note on `check_type` naming.** Two different tables use a `check_type` column, and they follow different conventions:
> - `add-sentinel-log --json '{"check_type":"price",...}'` writes to `sentinel_log.check_type`, which is a free-form descriptor (bare form: `price`, `liquidity`, `wallet`, `contract`, `all`, `emergency`). Used by Observer when citing log rows.
> - `cclaw heartbeat ping --check <name>` writes to `heartbeat_state.check_type`, which MUST match a literal `HEARTBEAT_CADENCES.sentinel` key. The current keys are: `price_check`, `liquidity_check`, `wallet_check`, `smart_money_exits`, `contract_check` — note that `smart_money_exits` has no `_check` suffix. Unknown keys are silently ignored by `cclaw heartbeat overdue`.

## Every Heartbeat — Run ALL:

**Multi-chain:** Run position checks for ALL active chains. Positions have a `chain` field — iterate and check each chain's positions separately.

### 1. Price Check (CRITICAL)
[cclaw expansion pending P5b — `cclaw positions check-prices` not yet implemented; price monitoring against stop-loss/take-profit thresholds is now also handled by PriceCheckProcessor (NestJS worker). Read open positions and evaluate stops manually.]
```bash
cclaw positions list --status open
```
```bash
cclaw heartbeat ping --agent sentinel --check price_check
```
- Compare current prices against stop-loss and take-profit levels on each open position
- If stop-loss hit → write sell order: `cclaw orders propose --json '{"action":"sell",...}'`, alert human
- If take-profit hit → write partial sell order, inform human
- If price dropped >20% since last check → write alert
- **If `cclaw positions list` fails:** log `node scripts/db-query.js add-sentinel-log --json '{"check_type":"price","status":"error","summary":"<reason>"}'` AND `node scripts/send-alert.js --type rug_warning --agent sentinel --message "price check failed — positions unmonitored: <reason>"`. Do not proceed to evaluate stops against stale data. (See AGENTS.md § Error Self-Reporting.)
- **If `cclaw orders propose` for a sell fails:** `node scripts/send-alert.js --type sell_triggered --agent sentinel --message "SELL ORDER WRITE FAILED for <symbol>: <reason>"`. The worst failure mode Sentinel has.

### 2. Liquidity Check (CRITICAL)
[cclaw expansion pending P5b — `cclaw positions check-liquidity` not yet implemented; liquidity monitoring is now also handled by LiquidityCheckProcessor (NestJS worker). Check liquidity snapshots via db-query hold-back.]
```bash
node scripts/db-query.js get-liquidity --address <ADDR> --chain <CHAIN> --limit 2
```
(legacy hold-back)
```bash
cclaw heartbeat ping --agent sentinel --check liquidity_check
```
- Compares current liquidity against the **oldest snapshot inside each window** (1h and 24h) — catches slow bleeds the per-check delta misses
- If dropped >30% in 1h → CRITICAL: write sell-all order, alert human
- If dropped >15% in 24h → HIGH: write alert
- If no snapshot exists inside a window (fresh position), that band is skipped for this cycle
- Save new snapshot: `node scripts/db-query.js add-liquidity-snapshot --address ... --chain ... --liquidity ...` (legacy hold-back)
- **If the liquidity query fails:** log `node scripts/db-query.js add-sentinel-log --json '{"check_type":"liquidity","status":"error","summary":"<reason>"}'` AND `node scripts/send-alert.js --type rug_warning --agent sentinel --message "liquidity check failed — rug detection blind: <reason>"`. A failed liquidity check means you cannot detect a rug this cycle.

### 3. Wallet Check (if positions exist)
[cclaw expansion pending P5b — `cclaw wallets check --positions` not yet implemented; dev/whale wallet monitoring is now also handled by WalletMonitorProcessor (NestJS worker). Use smart-money signals as a proxy below.]
```bash
node scripts/db-query.js get-smart-money-signals --since 30m --action sell --tokens-in-positions --group-by token
```
(legacy hold-back — check for dev/deployer selling via smart-money signal table)
```bash
cclaw heartbeat ping --agent sentinel --check wallet_check
```
- Check smart-money signals for dev/deployer wallets selling held tokens
- If dev selling detected → write sell-all order, alert human
- **If the query fails:** log `node scripts/db-query.js add-sentinel-log --json '{"check_type":"wallet","status":"error","summary":"<reason>"}'` AND `node scripts/send-alert.js --type rug_warning --agent sentinel --message "wallet check failed — dev/whale activity unknown this cycle: <reason>"`.

### 4. Smart-Money Exit Signals (if positions exist)
Read SELL signals on tokens we currently hold, written by the WalletActivityProcessor (NestJS worker):
```bash
node scripts/db-query.js get-smart-money-signals --since 30m --action sell --tokens-in-positions --group-by token
```
(legacy hold-back — `cclaw wallets signals` pending P5b)
```bash
cclaw heartbeat ping --agent sentinel --check smart_money_exits
```

| Condition | Severity | Action |
|-----------|----------|--------|
| ≥ 2 distinct `smart_money` wallets sold a held token in last 30 min | HIGH | Alert via `node scripts/send-alert.js --type sell_triggered --agent sentinel --message "Smart-money exiting $TOKEN — N wallets sold in 30m, consider tightening stops"`. Do NOT auto-write a sell order — informational only. |
| 1 `smart_money` sell on a held token | NOTABLE | Log to `sentinel_log` with `status:"notable"`. No Telegram alert. |
| 0 sells | INFO | Silent. |

Why no auto-sell: smart-money "sells" can be wallet-to-wallet rotations, bridges, or misclassified swaps. Smart-money exit clusters are a heads-up for Research / the operator to decide.

### 5. Contract Check (max 2x per hour)
```bash
cclaw heartbeat overdue --agent sentinel
```
Only run the following if `contract_check` appears in the overdue array:
[cclaw expansion pending P5b — `cclaw positions check-contracts` not yet implemented; contract safety monitoring is now also handled by ContractSafetyProcessor (NestJS worker). Check contract snapshots via db-query hold-back.]
```bash
node scripts/db-query.js get-contract-snapshots --address <ADDR> --chain <CHAIN> --limit 2
```
(legacy hold-back — compare latest vs previous snapshot for safety field changes)
```bash
cclaw heartbeat ping --agent sentinel --check contract_check
```
- Diffs GoPlus safety data against previous snapshot in `contract_snapshots`
- If became honeypot/pausable/blacklisted/proxy changed → CRITICAL: write sell-all order, alert human
- If owner changed, tax increased >5%, became mintable → HIGH: write alert
- First run per token stores baseline snapshot (no alerts)
- **If the contract query fails:** log `node scripts/db-query.js add-sentinel-log --json '{"check_type":"contract","status":"error","summary":"<reason>"}'` AND `node scripts/send-alert.js --type rug_warning --agent sentinel --message "contract check failed — can't detect proxy/pausable/blacklist changes: <reason>"`.

### 6. Log Results
```bash
node scripts/db-query.js add-sentinel-log --json '{"check_type":"all","positions_checked":5,"alerts_generated":0,"sells_executed":0,"status":"ok"}'
```
(legacy hold-back) Use status: `"ok"` if nothing happened or sell orders were written cleanly, `"notable"` if Tier 2 events occurred (price >20% drop without sell, liquidity 15-30%, tax >5%, mintable), `"error"` if a check crashed (see AGENTS.md § Error Self-Reporting). Stay within this set — your own 3h-summary logic in Step 7 reads `"notable"`, and Observer's silent-crash detector reads `"error"`.

### 7. Summary Decision (ONLY after logging)
Decide whether to send a periodic summary. Do NOT send alerts for quiet heartbeats.

1. **Did you write sell orders this cycle?** → Immediate `sell_triggered` alert already sent in the skill. Done.
2. **Were there notable (non-sell) events?** (price >20% drop, liquidity 15-30%, tax >5%, mintable) → Already logged with `status: "notable"` above. Do NOT send a Telegram alert now.
3. **Is a periodic summary due?** Check:
   ```bash
   node scripts/db-query.js get-sentinel-log --limit 12
   ```
   (legacy hold-back) — covers ~3h of 15-min heartbeats
   - If notable logs exist in last 3h AND you haven't sent a summary in this window → send `heartbeat_summary` with event details
   - If no summary sent in >24h → send mandatory daily proof-of-life summary
   - Otherwise → **stay completely silent**

Summary format:
```bash
node scripts/send-alert.js --type heartbeat_summary --agent sentinel --message "SENTINEL SUMMARY (last 3h)\nHeartbeats: N | Positions: N\nNotable: [events or all clear]\nSells written: N\nStatus: OPERATIONAL"
```

## Rules
- Run every check that is due — the always-on ones (price, liquidity, wallet, smart-money exits) plus any rotating check (contract) the overdue array surfaces this cycle. Do not selectively drop checks.
- Never skip a check to save tokens — your whole job is checking
- If no open positions in DB → bump every heartbeat (see *No-positions heartbeat* below) and then reply HEARTBEAT_OK. Skipping the bump makes Observer think the agent died.
- Keep total response under 500 tokens when nothing is wrong
- Do NOT call `node scripts/send-alert.js` when all checks pass with no events — quiet runs produce zero Telegram messages
- Only send Telegram alerts for: sell orders (immediate), periodic summaries (3h cadence if notable events), or 24h proof-of-life

## No-positions heartbeat
When there are zero open positions, the always-on checks (price, liquidity, wallet) and the rotating check (contract) all have nothing to do. They still ran logically — there was just nothing to check. Bump every heartbeat so Observer's staleness detector sees the agent as alive. Each command must be in its own code fence (one command per exec call).
```bash
cclaw heartbeat ping --agent sentinel --check price_check
```
```bash
cclaw heartbeat ping --agent sentinel --check liquidity_check
```
```bash
cclaw heartbeat ping --agent sentinel --check wallet_check
```
```bash
cclaw heartbeat ping --agent sentinel --check smart_money_exits
```
```bash
cclaw heartbeat ping --agent sentinel --check contract_check
```
Then log the cycle as ok with `positions_checked: 0` via `node scripts/db-query.js add-sentinel-log` (Step 6, legacy hold-back) and reply HEARTBEAT_OK.
