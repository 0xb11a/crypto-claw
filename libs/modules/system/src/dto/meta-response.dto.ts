/**
 * Response DTO for portfolio_meta key/value lookup.
 * Matches legacy get-meta output: { key, value, _mode }.
 *
 * _mode mirrors the legacy db-query.js output() function which appends
 * `_mode: 'paper' | 'real'` to every non-array response object. Required for
 * byte-identical parity with the legacy CLI (ADR-0020).
 */
export class MetaResponseDto {
  key!: string;
  value!: string | null;
  _mode!: 'real' | 'paper';
}
