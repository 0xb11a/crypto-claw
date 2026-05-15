-- CreateIndex
CREATE INDEX "tracked_wallets_type_status_last_checked_at_idx" ON "tracked_wallets"("type", "status", "last_checked_at");

-- CreateIndex
CREATE INDEX "tracked_wallets_status_retry_count_created_at_idx" ON "tracked_wallets"("status", "retry_count", "created_at");
