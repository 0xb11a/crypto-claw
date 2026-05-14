/**
 * Response DTO for GET /v1/system/cash (no chain param).
 *
 * Matches legacy getAllCashBreakdown() output shape:
 * { [chain]: number, ..., total: number }
 *
 * The shape is flat: per-chain cash values keyed by chain name, plus a `total` field.
 * Example: { base: 500.0, solana: 250.0, total: 750.0 }
 * This is a flexible Record since chains vary by deployment config.
 */
export class CashBreakdownDto {
  /** Per-chain cash + total: { base: 500, solana: 250, total: 750 } */
  [key: string]: number;
}
