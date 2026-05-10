/** Valid position status values (mirrors legacy CHECK constraint). */
export declare const POSITION_STATUSES: readonly [
  'open',
  'partial_exit',
  'closed',
  'pending_analysis',
  'draft',
  'pending_exit',
];
export type PositionStatus = (typeof POSITION_STATUSES)[number];
/** Query parameters for GET /v1/positions (SPEC §5). */
export declare class PositionListQueryDto {
  status?: PositionStatus;
  mode?: 'real' | 'paper';
  symbol?: string;
  chain?: string;
  limit?: number;
  cursor?: string;
}
//# sourceMappingURL=position-list-query.dto.d.ts.map
