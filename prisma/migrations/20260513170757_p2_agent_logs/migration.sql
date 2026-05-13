-- CreateTable
CREATE TABLE "research_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "check_type" TEXT NOT NULL,
    "tokens_scanned" INTEGER NOT NULL DEFAULT 0,
    "tokens_analyzed" INTEGER NOT NULL DEFAULT 0,
    "trades_proposed" INTEGER NOT NULL DEFAULT 0,
    "alerts_processed" INTEGER NOT NULL DEFAULT 0,
    "watchlist_hits" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "created_at" TEXT
);

-- CreateTable
CREATE TABLE "sentinel_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "check_type" TEXT NOT NULL,
    "positions_checked" INTEGER NOT NULL DEFAULT 0,
    "alerts_generated" INTEGER NOT NULL DEFAULT 0,
    "sells_executed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "summary" TEXT,
    "created_at" TEXT
);

-- CreateTable
CREATE TABLE "executor_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sell_orders_processed" INTEGER NOT NULL DEFAULT 0,
    "buy_orders_processed" INTEGER NOT NULL DEFAULT 0,
    "pending_checked" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "queued_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "summary" TEXT,
    "created_at" TEXT
);

-- CreateTable
CREATE TABLE "observer_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "errors_analyzed" INTEGER NOT NULL DEFAULT 0,
    "issues_created" INTEGER NOT NULL DEFAULT 0,
    "alerts_sent" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "created_at" TEXT
);

-- CreateIndex
CREATE INDEX "research_log_created_at_idx" ON "research_log"("created_at");

-- CreateIndex
CREATE INDEX "sentinel_log_created_at_idx" ON "sentinel_log"("created_at");

-- CreateIndex
CREATE INDEX "executor_log_created_at_idx" ON "executor_log"("created_at");

-- CreateIndex
CREATE INDEX "observer_log_created_at_idx" ON "observer_log"("created_at");
