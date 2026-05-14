-- CreateTable
CREATE TABLE "analysis_cache" (
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "symbol" TEXT,
    "analysis_score" INTEGER,
    "risk_score" INTEGER,
    "verdict" TEXT NOT NULL,
    "tier" TEXT,
    "reasoning" TEXT,
    "expires_at" TEXT NOT NULL,
    "created_at" TEXT,

    PRIMARY KEY ("address", "chain")
);

-- CreateTable
CREATE TABLE "contract_snapshots" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "safety_data" TEXT NOT NULL,
    "checked_at" TEXT
);

-- CreateTable
CREATE TABLE "portfolio_sync" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "chain" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "positions_synced" INTEGER NOT NULL DEFAULT 0,
    "positions_closed" INTEGER NOT NULL DEFAULT 0,
    "positions_discovered" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "synced_at" TEXT
);

-- CreateIndex
CREATE INDEX "analysis_cache_expires_at_idx" ON "analysis_cache"("expires_at");

-- CreateIndex
CREATE INDEX "idx_contract_snapshots" ON "contract_snapshots"("address", "chain");
