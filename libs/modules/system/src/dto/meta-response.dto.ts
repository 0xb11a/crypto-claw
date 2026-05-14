/**
 * Response DTO for portfolio_meta key/value lookup.
 * Matches legacy get-meta output: { key, value }.
 */
export class MetaResponseDto {
  key!: string;
  value!: string | null;
}
