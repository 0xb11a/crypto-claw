/**
 * Response DTO for contract_snapshots rows.
 *
 * Field names use snake_case to match the SELECT * output from db-query.js
 * for byte-identical parity (ADR-0020).
 * safety_data is returned as raw String — never parsed.
 */
export class ContractSnapshotResponseDto {
  id!: number;
  address!: string;
  chain!: string;
  /** Raw JSON string — stored and returned as-is, never parsed. */
  safety_data!: string;
  checked_at!: string | null;
}
