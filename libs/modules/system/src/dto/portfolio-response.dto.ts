/**
 * Response DTOs for GET /v1/system/portfolio.
 *
 * Two shapes mirror the legacy db-query.js `get-portfolio` handler (lines 454-499):
 *   - PortfolioChainDto   — per-chain slice used inside PortfolioResponseDto.chains.
 *   - PortfolioSingleChainResponseDto — returned when ?chain=X is supplied.
 *   - PortfolioResponseDto            — returned when no chain filter is supplied.
 *
 * Position items use snake_case to match the raw Prisma row + parity contract
 * (ADR-0020). Field names intentionally match the SELECT * shape from the legacy
 * script.
 */

/** Per-chain slice when returning all chains. */
export class PortfolioChainDto {
  /** Total cash held in this chain's cash token (USDC/USDT). */
  cash!: number;
  /** Open/partial_exit positions on this chain. */
  positions!: unknown[];
  /** cash + position value, rounded to 2 dp. */
  total_value!: number;
}

/** Response when a specific ?chain=X is supplied. */
export class PortfolioSingleChainResponseDto {
  safe_id!: string | null;
  chain!: string;
  cash!: number;
  total_deposited!: number;
  positions!: unknown[];
  /** cash + position value, rounded to 2 dp. */
  total_value!: number;
  _mode!: 'real' | 'paper';
}

/** Response when no chain filter is supplied (all-chains view). */
export class PortfolioResponseDto {
  safe_id!: string | null;
  /** Map of chain name → per-chain portfolio slice. */
  chains!: Record<string, PortfolioChainDto>;
  /** Sum of all chains' total_value, rounded to 2 dp. */
  total_value!: number;
  _mode!: 'real' | 'paper';
}
