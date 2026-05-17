# TOOLS.md — Research Agent Tool Reference

## General Notes
- All scripts output **valid JSON to stdout**; errors go to stderr; exit 0 = success, 1 = failure.
- `jq` is available; use only when extracting a specific field.
- Web/browser tools are disabled. All market data comes from the scripts below.
- **Run one command per exec call.** Never chain with `&&`, `||`, `;`, and never redirect with `2>/dev/null` — OpenClaw's exec preflight rejects compound commands.

## Logging Severity Rubric (`scripts/log.js`)
- `info` — routine step completed. Never actionable.
- `warn` — degraded but self-healing (retry succeeded, cache miss, fallback used).
- `error` — operation did not complete (DB write failed, pipeline aborted). **Each instance actionable.**
- `critical` — safety/integrity violation (key leak, emergency mode, data corruption). **Immediate Observer alert.**

If an unhandled exception kills a step, log at `error` or `critical` — never `warn`.

## JSON Schemas (referenced from commands below)

**Order (buy):** `{id, action:"buy", symbol, address, chain, amount, tier, entry_price, stop_loss, take_profit_levels:[{level,price,sellPercent}], reasoning, analysis_score?, risk_score?, percent_of_portfolio?}`

**Order (sell):** `{id, action:"sell", symbol, address, chain, amount, reason, urgency}` — `amount` may be `"all"` or numeric.

**Position:** `{id, symbol, address, chain, tier, entry_price, quantity, stop_loss, take_profit_levels:[…]}`.

**Receipt:** `{id, order_id, action, symbol, address, chain, status, safe_tx_hash?, onchain_tx_hash?, executed_price, slippage}`.

**Watchlist entry:** `{symbol, address, chain, reason, target_entry}`.

## API CLI (`cclaw`) and legacy CLI (`db-query.js`)

Prefer `cclaw` where listed; use `node scripts/db-query.js` for legacy hold-backs (commands without a `cclaw` equivalent yet, pending P5b/P6 expansion). Commands without a `cclaw` equivalent are annotated `(legacy hold-back)`.

**Run one command per exec call.** Never chain with `&&`, `||`, `;`, and never redirect with `2>/dev/null`.

### Chain discovery (legacy hold-back)
```bash
node scripts/db-query.js get-chains
```
```bash
node scripts/db-query.js get-chain-config --chain <CHAIN>
```

### Positions
```bash
cclaw positions list [--status open|closed|all] [--chain <CHAIN>]
```
```bash
cclaw positions get --id <ID>
```

### Portfolio & cash (legacy hold-back — `cclaw portfolio` pending P5b)
```bash
node scripts/db-query.js get-portfolio [--chain <CHAIN>]
```
```bash
node scripts/db-query.js get-cash [--chain <CHAIN>]
```
```bash
node scripts/db-query.js get-meta --key <K>
```

### Orders (Research → Executor)
State machine: `pending → approved → executed` (or `rejected`/`cancelled`/`failed`). Failed sells can be retried; failed buys must be re-proposed.

```bash
cclaw orders list [--pending] [--status <S>] [--action buy|sell]
```
```bash
cclaw orders get --id <ID>
```
```bash
cclaw orders propose --json '<Order(buy)>'
```
Returns `{status, approved_by}`; act on the returned status (`pending` → call `send-approval.js`; `approved` → Executor will pick it up).
```bash
cclaw orders approve --id <ID> --by human
```
```bash
cclaw orders reject --id <ID> --reason "<r>"
```
```bash
node scripts/db-query.js cancel-order --id <ID> --reason "<r>" --by human
```
(cancel-order is legacy hold-back — `cclaw orders cancel` pending P5b)
```bash
node scripts/db-query.js retry-order --id <ID> --by human
```
(retry-order is legacy hold-back — `cclaw orders retry` pending P5b)

### Receipts
```bash
cclaw receipts list [--limit N]
```
```bash
cclaw receipts get --id <ID>
```
```bash
cclaw receipts create --json '<Receipt>'
```

### Sentinel alerts
```bash
cclaw alerts list --unprocessed
```
```bash
cclaw alerts ack --id <ID>
```

### Watchlist (legacy hold-back — `cclaw watchlist` pending P5b)
```bash
node scripts/db-query.js get-watchlist [--active]
```
```bash
node scripts/db-query.js add-to-watchlist --json '<Watchlist>'
```
```bash
node scripts/db-query.js update-watchlist --id <ID> --json '{target_entry?, reason?}'
```
```bash
node scripts/db-query.js remove-from-watchlist --id <ID>
```

### Liquidity & contract snapshots (legacy hold-back)
```bash
node scripts/db-query.js get-liquidity --address <ADDR> --chain <CHAIN>
```
```bash
node scripts/db-query.js add-liquidity-snapshot --address <ADDR> --chain <CHAIN> --liquidity <N>
```
```bash
node scripts/db-query.js get-contract-snapshots --address <ADDR> --chain <CHAIN> [--limit N]
```
```bash
node scripts/db-query.js add-contract-snapshot --address <ADDR> --chain <CHAIN> --json '<safety_data>'
```

### Wallet tracking & scoring (legacy hold-back — `cclaw wallets` pending P5b)
Wallet types: `smart_money` (75+), `whale` (55-74), `trader` (35-54), `retail` (0-34), plus `dev`, `deployer`. With `type` set → `status='scored'`; without → `status='proposed'`.

```bash
node scripts/db-query.js get-tracked-wallets [--status scored]
```
```bash
node scripts/db-query.js add-tracked-wallet --json '{address,chain,label,type}'
```
```bash
node scripts/db-query.js remove-tracked-wallet --address <ADDR> --chain <CHAIN>
```
```bash
node scripts/db-query.js propose-wallet --json '{address,chain,label,source_token}'
```
Fast, no API calls; consumed by WalletScoringProcessor (NestJS worker, every 10 min).
```bash
node scripts/db-query.js get-unscored-wallets [--limit N]
```
```bash
node scripts/db-query.js update-wallet-score --address <ADDR> --chain <CHAIN> --json '{score,type,score_breakdown:{…},status:"scored"}'
```

`source_token` values: `agent`, `leaderboard`, `token_traders`, `holder_extraction`. Background scoring (WalletScoringProcessor, every 10 min) auto-classifies; failed wallets retry up to 3 times. See CLAUDE.md § Wallet Pipeline for the full flow.

### Smart-money signals (legacy hold-back — `cclaw wallets signals` pending P5b)
Per-swap signals from WalletActivityProcessor (NestJS worker, every 30 min, 24 h retention).

```bash
node scripts/db-query.js get-smart-money-signals --since 35m --action buy --group-by token --min-wallets 2
```
```bash
node scripts/db-query.js get-smart-money-signals --since 1h --chain <CHAIN> --limit 50
```
- Aggregated row: `{token_address, chain, token_symbol, signal_count, n_wallets, avg_score, buys, sells, first_seen, last_seen}` sorted by `n_wallets DESC, signal_count DESC`.
- Raw row (no `--group-by`): full record with `tx_hash, wallet_address, wallet_score, action, counter_token_*, amount_token, tx_timestamp`.

### Heartbeat & logs
```bash
cclaw heartbeat get --agent research
```
```bash
cclaw heartbeat overdue --agent research
```
Server-side cadence; do not override.
```bash
cclaw heartbeat ping --agent research --check <check_type>
```
```bash
node scripts/db-query.js add-research-log --json '{check_type, tokens_scanned?, tokens_analyzed?, trades_proposed?, alerts_processed?, watchlist_hits?, summary, status:"ok"|"error"}'
```
(add-research-log is legacy hold-back — `cclaw agent-logs create` pending P5b)
```bash
node scripts/db-query.js get-research-log [--limit N]
```
(legacy hold-back)
```bash
node scripts/db-query.js get-trade-stats [--chain <CHAIN>]
```
Returns `{total_trades, wins, losses, avg_win/loss_percent, total_pnl_usd, best/worst_trade_pnl, win_rate, current_value, initial_balance, total_return_percent}`. (legacy hold-back)

### Portfolio sync (legacy hold-back)
```bash
node scripts/db-query.js sync-portfolio --chain <CHAIN> [--trigger periodic|post_trade]
```
Returns `{ok: false, message: 'Portfolio sync skipped...'}` when on-chain sync is disabled; proceed without action.
```bash
node scripts/db-query.js get-sync-status [--chain <CHAIN>]
```
```bash
node scripts/db-query.js set-onchain-balance --id <position_id> --balance <N>
```

### Analysis cache / token dedup (legacy hold-back)
```bash
node scripts/db-query.js check-token-status --address <ADDR> --chain <CHAIN>
```
Returns `{action:"skip"|"analyze", reason}`. Checks open positions, pending orders, watchlist, cached analysis. Run before any analyst/risk skill invocation.
```bash
node scripts/db-query.js cache-analysis --json '{address, chain, symbol?, analysis_score?, risk_score?, verdict:"avoid"|"risk_rejected", reasoning, ttl_hours?}'
```
Default TTL 24 h.
```bash
node scripts/db-query.js get-analysis-cache
```
```bash
node scripts/db-query.js clear-expired-cache
```

## Data Sources (P5 — NestJS-backed)

As of P5, the standalone data-fetching scripts were deleted. Market data is now provided by NestJS worker processors or read from the database via db-query.js hold-backs. [cclaw expansion pending P5b for full cclaw market commands]

### Token data (pending P5b cclaw expansion)
- Token scanning: `cclaw positions list --status pending_analysis` (auto-discovered tokens from on-chain sync)
- Contract snapshots: `node scripts/db-query.js get-contract-snapshots --address <ADDR> --chain <CHAIN>` (legacy hold-back — cached GoPlus data)
- Liquidity snapshots: `node scripts/db-query.js get-liquidity --address <ADDR> --chain <CHAIN>` (legacy hold-back)

### Market regime
- Read current regime: `node scripts/db-query.js get-meta --key market_regime` (legacy hold-back — set by MarketRegimeProcessor NestJS worker)

### Heartbeat pre-check
- `heartbeat-check.js --agent <executor|sentinel>` → `{agent, skip, reason|open_positions}` (retained script).

### Telegram alerts
Alerts route to the correct supergroup topic automatically. Types used by Research: `trade_proposal` → Research topic, `model_failure` → Alerts topic, `rebalance_event` → Portfolio topic, `recovered` → System topic, `sentinel_alert_followup` → Research topic.

```bash
cclaw alerts send --type <TYPE> --agent research --message "<MESSAGE>"
```

Per AGENTS.md § Error Self-Reporting, fire `model_failure` whenever any pipeline step fails.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ACTIVE_CHAINS` | env | Comma-separated active chains. Run `node scripts/db-query.js get-chains` (legacy hold-back) for the live list. |

## Important Notes
- NEVER pass wallet private keys to any script — scripts only READ external data.
