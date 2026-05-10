import { PositionsService } from './positions.service.js';
import { CreatePositionDto } from './dto/create-position.dto.js';
import { UpdatePositionDto } from './dto/update-position.dto.js';
import { ClosePositionDto } from './dto/close-position.dto.js';
import { PositionListQueryDto } from './dto/position-list-query.dto.js';
import type { PositionListResponseDto, PositionResponseDto } from './dto/position-response.dto.js';
/**
 * Positions controller — HTTP surface for the positions module (SPEC §5).
 *
 * Routes:
 *   GET    /v1/positions          - list (agent + dashboard)
 *   GET    /v1/positions/:id      - get by id (agent + dashboard)
 *   POST   /v1/positions          - create (agent only) @Audited
 *   PATCH  /v1/positions/:id      - update (agent only) @Audited
 *   POST   /v1/positions/:id/close - close (agent only) @Audited
 *   DELETE /v1/positions/:id      - delete (agent only) @Audited
 *
 * Every handler has @Roles(…) (SPEC §4 #3).
 * Every non-GET handler has @Audited() (SPEC §9.5, ADR-0018).
 */
export declare class PositionsController {
  private readonly svc;
  constructor(svc: PositionsService);
  list(query: PositionListQueryDto): Promise<PositionListResponseDto>;
  getById(id: string, mode?: 'real' | 'paper'): Promise<PositionResponseDto>;
  create(dto: CreatePositionDto): Promise<PositionResponseDto>;
  update(id: string, dto: UpdatePositionDto, mode?: 'real' | 'paper'): Promise<PositionResponseDto>;
  close(id: string, dto: ClosePositionDto, mode?: 'real' | 'paper'): Promise<PositionResponseDto>;
  delete(id: string, mode?: 'real' | 'paper'): Promise<void>;
}
//# sourceMappingURL=positions.controller.d.ts.map
