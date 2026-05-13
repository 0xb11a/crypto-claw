-- CreateTable
CREATE TABLE "tracked_wallets" (
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "label" TEXT,
    "type" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "score" INTEGER,
    "score_breakdown" TEXT,
    "source_token" TEXT,
    "scored_at" TEXT,
    "score_error" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT DEFAULT 'agent',
    "last_checked_at" TEXT,
    "created_at" TEXT,

    PRIMARY KEY ("address", "chain")
);

-- CreateTable
CREATE TABLE "smart_money_signals" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tx_hash" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "wallet_score" INTEGER,
    "wallet_label" TEXT,
    "action" TEXT NOT NULL,
    "token_address" TEXT NOT NULL,
    "token_symbol" TEXT,
    "counter_token_address" TEXT,
    "counter_token_symbol" TEXT,
    "amount_token" TEXT,
    "tx_timestamp" TEXT NOT NULL,
    "created_at" TEXT
);

-- CreateTable
CREATE TABLE "liquidity_snapshots" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "liquidity_usd" REAL NOT NULL,
    "checked_at" TEXT
);

-- CreateTable
CREATE TABLE "watchlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "target_entry" REAL,
    "current_price" REAL,
    "analysis_score" INTEGER,
    "risk_score" INTEGER,
    "narrative" TEXT,
    "reason" TEXT,
    "expires_at" TEXT,
    "status" TEXT NOT NULL DEFAULT 'watching',
    "created_at" TEXT,
    "updated_at" TEXT
);

-- CreateIndex
CREATE INDEX "idx_smart_money_signals_created_at" ON "smart_money_signals"("created_at");

-- CreateIndex
CREATE INDEX "idx_smart_money_signals_token" ON "smart_money_signals"("token_address", "chain", "created_at");

-- CreateIndex
CREATE INDEX "idx_smart_money_signals_chain" ON "smart_money_signals"("chain", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "smart_money_signals_tx_hash_wallet_address_action_token_address_key" ON "smart_money_signals"("tx_hash", "wallet_address", "action", "token_address");

-- CreateIndex
CREATE INDEX "idx_liquidity_address" ON "liquidity_snapshots"("address", "chain");

-- CreateIndex
CREATE INDEX "idx_watchlist_status" ON "watchlist"("status");

-- CreateIndex
CREATE INDEX "idx_watchlist_address_chain" ON "watchlist"("address", "chain");
