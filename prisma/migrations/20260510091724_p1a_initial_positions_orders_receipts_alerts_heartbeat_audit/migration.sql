-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "name" TEXT,
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "entry_price" REAL NOT NULL,
    "current_price" REAL,
    "quantity" REAL NOT NULL,
    "value_usd" REAL,
    "percent_of_portfolio" REAL,
    "entry_date" TEXT NOT NULL,
    "stop_loss" REAL NOT NULL,
    "take_profit_levels" TEXT NOT NULL,
    "narrative" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "notes" TEXT,
    "onchain_balance" REAL,
    "last_synced_at" TEXT,
    "exit_price" REAL,
    "exit_date" TEXT,
    "pnl_percent" REAL,
    "pnl_usd" REAL,
    "exit_reason" TEXT,
    "max_price_since_entry" REAL,
    "trailing_stop_pct" REAL,
    "trailing_stop_active" INTEGER NOT NULL DEFAULT 0,
    "tp_levels_hit" TEXT NOT NULL DEFAULT '[]',
    "created_at" TEXT,
    "updated_at" TEXT
);

-- CreateTable
CREATE TABLE "paper_positions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "entry_price" REAL NOT NULL,
    "current_price" REAL,
    "quantity" REAL NOT NULL,
    "value_usd" REAL,
    "entry_date" TEXT NOT NULL,
    "stop_loss" REAL NOT NULL,
    "take_profit_levels" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "exit_price" REAL,
    "exit_date" TEXT,
    "pnl_percent" REAL,
    "pnl_usd" REAL,
    "exit_reason" TEXT,
    "max_price_since_entry" REAL,
    "trailing_stop_pct" REAL,
    "trailing_stop_active" INTEGER NOT NULL DEFAULT 0,
    "tp_levels_hit" TEXT NOT NULL DEFAULT '[]',
    "created_at" TEXT,
    "updated_at" TEXT
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT,
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "percent_of_portfolio" REAL,
    "tier" TEXT,
    "entry_price" REAL,
    "stop_loss" REAL,
    "take_profit_levels" TEXT,
    "analysis_score" INTEGER,
    "risk_score" INTEGER,
    "reasoning" TEXT,
    "reason" TEXT,
    "urgency" TEXT,
    "approved_at" TEXT,
    "approved_by" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "status_reason" TEXT,
    "status_changed_at" TEXT,
    "status_changed_by" TEXT,
    "updated_at" TEXT,
    "tg_message_id" INTEGER,
    "created_at" TEXT
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "order_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "amount" REAL,
    "quantity" REAL,
    "expected_price" REAL,
    "executed_price" REAL,
    "slippage" REAL,
    "status" TEXT NOT NULL,
    "safe_tx_hash" TEXT,
    "onchain_tx_hash" TEXT,
    "safe_nonce" INTEGER,
    "signatures_collected" INTEGER,
    "signatures_required" INTEGER,
    "gas_used" TEXT,
    "error" TEXT,
    "notes" TEXT,
    "position_id" TEXT,
    "created_at" TEXT
);

-- CreateTable
CREATE TABLE "paper_receipts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "order_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tier" TEXT,
    "proposed_price" REAL NOT NULL,
    "quantity" REAL,
    "amount" REAL,
    "stop_loss" REAL,
    "take_profit_levels" TEXT,
    "reasoning" TEXT,
    "pnl_percent" REAL,
    "pnl_usd" REAL,
    "created_at" TEXT
);

-- CreateTable
CREATE TABLE "sentinel_alerts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "alert_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "current_price" REAL,
    "trigger_price" REAL,
    "details" TEXT,
    "action" TEXT,
    "sell_amount" TEXT,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TEXT,
    "created_at" TEXT
);

-- CreateTable
CREATE TABLE "heartbeat_state" (
    "agent" TEXT NOT NULL,
    "check_type" TEXT NOT NULL,
    "last_run" TEXT,

    PRIMARY KEY ("agent", "check_type")
);

-- CreateTable
CREATE TABLE "portfolio_meta" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updated_at" TEXT
);

-- CreateTable
CREATE TABLE "service_audit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" TEXT NOT NULL DEFAULT '',
    "identity" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "body_sha256" TEXT NOT NULL,
    "body_redacted" TEXT,
    "status" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "error_kind" TEXT
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entry_price" REAL,
    "exit_price" REAL,
    "quantity" REAL NOT NULL,
    "entry_date" TEXT,
    "exit_date" TEXT,
    "pnl_percent" REAL,
    "pnl_usd" REAL,
    "exit_reason" TEXT,
    "analysis_score" INTEGER,
    "risk_score" INTEGER,
    "narrative" TEXT,
    "lesson" TEXT,
    "duration_days" INTEGER,
    "created_at" TEXT
);

-- CreateIndex
CREATE INDEX "idx_positions_status" ON "positions"("status");

-- CreateIndex
CREATE INDEX "idx_positions_chain" ON "positions"("chain");

-- CreateIndex
CREATE INDEX "idx_positions_address_chain" ON "positions"("address", "chain");

-- CreateIndex
CREATE INDEX "idx_paper_positions_status" ON "paper_positions"("status");

-- CreateIndex
CREATE INDEX "idx_paper_positions_address_chain" ON "paper_positions"("address", "chain");

-- CreateIndex
CREATE INDEX "idx_orders_status" ON "orders"("status");

-- CreateIndex
CREATE INDEX "idx_orders_action" ON "orders"("action");

-- CreateIndex
CREATE INDEX "idx_orders_address_chain" ON "orders"("address", "chain");

-- CreateIndex
CREATE INDEX "idx_receipts_order_id" ON "receipts"("order_id");

-- CreateIndex
CREATE INDEX "idx_receipts_status" ON "receipts"("status");

-- CreateIndex
CREATE INDEX "idx_paper_receipts_order_id" ON "paper_receipts"("order_id");

-- CreateIndex
CREATE INDEX "idx_sentinel_alerts_processed" ON "sentinel_alerts"("processed");

-- CreateIndex
CREATE INDEX "service_audit_identity_ts_idx" ON "service_audit"("identity", "ts");

-- CreateIndex
CREATE INDEX "service_audit_path_ts_idx" ON "service_audit"("path", "ts");

-- CreateIndex
CREATE INDEX "idx_trades_created_at" ON "trades"("created_at");
