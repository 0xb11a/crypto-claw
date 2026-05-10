import { PositionsRepository } from './positions.repository.js';
import type { CreatePositionDto } from './dto/create-position.dto.js';
import type { UpdatePositionDto } from './dto/update-position.dto.js';
import type { ClosePositionDto } from './dto/close-position.dto.js';
import type { PositionListQueryDto } from './dto/position-list-query.dto.js';
import type { PositionResponseDto, PositionListResponseDto } from './dto/position-response.dto.js';
/**
 * Positions service — domain logic layer.
 *
 * Services call repositories; they do not write Prisma queries directly.
 * Paper-mode routing is handled inside the repository; the service passes
 * mode through and handles domain-level errors.
 */
export declare class PositionsService {
  private readonly repo;
  constructor(repo: PositionsRepository);
  list(query: PositionListQueryDto): Promise<PositionListResponseDto>;
  getById(id: string, mode?: 'real' | 'paper'): Promise<PositionResponseDto>;
  create(dto: CreatePositionDto): Promise<PositionResponseDto>;
  update(id: string, dto: UpdatePositionDto, mode?: 'real' | 'paper'): Promise<PositionResponseDto>;
  close(id: string, dto: ClosePositionDto, mode?: 'real' | 'paper'): Promise<PositionResponseDto>;
  delete(id: string, mode?: 'real' | 'paper'): Promise<void>;
}
//# sourceMappingURL=positions.service.d.ts.map
