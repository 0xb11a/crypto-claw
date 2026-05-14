/**
 * Response DTO for portfolio_sync rows.
 *
 * Field names use snake_case to match the SELECT * output from db-query.js
 * for byte-identical parity (ADR-0020).
 */
export class PortfolioSyncResponseDto {
  id!: number;
  chain!: string;
  provider!: string;
  trigger!: string;
  status!: string;
  positions_synced!: number;
  positions_closed!: number;
  positions_discovered!: number;
  error!: string | null;
  synced_at!: string | null;
}
