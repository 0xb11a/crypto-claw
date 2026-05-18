/**
 * Response DTO for GET /v1/system/chains.
 *
 * Mirrors the legacy db-query.js `get-chains` output:
 *   output({ active: getActiveChains(), all: getAllChains() })
 */
export class ChainsResponseDto {
  /** Chain names enabled via ACTIVE_CHAINS config (ADR-0026). */
  active!: string[];
  /** All known chain names regardless of ACTIVE_CHAINS. */
  all!: string[];
}
