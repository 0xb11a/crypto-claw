/**
 * Response DTO for GET /v1/system/cash (no chain param).
 *
 * Matches legacy getAllCashBreakdown() + output() shape:
 * { [chain]: number, ..., total: number, _mode: 'real' | 'paper' }
 *
 * The shape is flat: per-chain cash values keyed by chain name, plus `total` and
 * `_mode` fields. `_mode` mirrors the legacy db-query.js output() function which
 * appends `_mode: 'paper' | 'real'` to every non-array response object. Required
 * for byte-identical parity with the legacy CLI (ADR-0020).
 */
export class CashBreakdownDto {
  /** Per-chain cash + total: { base: 500, solana: 250, total: 750, _mode: 'real' } */
  [key: string]: number | string;
}
