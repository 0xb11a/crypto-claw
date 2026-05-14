/**
 * Response DTO for analysis_cache rows.
 *
 * Field names use snake_case to match the `SELECT *` output from db-query.js
 * for byte-identical parity (ADR-0020).
 */
export class AnalysisCacheResponseDto {
  address!: string;
  chain!: string;
  symbol!: string | null;
  analysis_score!: number | null;
  risk_score!: number | null;
  verdict!: string;
  tier!: string | null;
  reasoning!: string | null;
  /** SQLite TEXT "YYYY-MM-DD HH:MM:SS" (non-Z) — never ISO-Z. */
  expires_at!: string;
  created_at!: string | null;
}
