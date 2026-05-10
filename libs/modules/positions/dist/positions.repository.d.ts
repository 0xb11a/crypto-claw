import { PrismaService } from '@cclaw/prisma';
import type { CreatePositionDto } from './dto/create-position.dto.js';
import type { UpdatePositionDto } from './dto/update-position.dto.js';
import type { ClosePositionDto } from './dto/close-position.dto.js';
import type { PositionListQueryDto } from './dto/position-list-query.dto.js';
import type { PositionResponseDto } from './dto/position-response.dto.js';
type Mode = 'real' | 'paper';
/**
 * Positions repository — the only place Prisma queries for positions live.
 *
 * Discriminates on `mode` to select `positions` vs `paper_positions` table.
 * JSON-string fields (take_profit_levels, tp_levels_hit) are parsed/serialised
 * at this boundary to maintain byte-identical parity with db-query.js (OPEN-5).
 */
export declare class PositionsRepository {
  private readonly prisma;
  constructor(prisma: PrismaService);
  /** Parse a JSON-string column to a typed array, falling back to []. */
  private parseJsonArray;
  /** Serialise an array to a JSON string for storage. */
  private toJsonString;
  /** Map a raw Position DB row to the response shape. */
  private mapPosition;
  /** Map a raw PaperPosition DB row to the response shape. */
  private mapPaperPosition;
  findMany(query: PositionListQueryDto): Promise<PositionResponseDto[]>;
  findById(id: string, mode?: Mode): Promise<PositionResponseDto>;
  create(dto: CreatePositionDto): Promise<PositionResponseDto>;
  update(id: string, dto: UpdatePositionDto, mode?: Mode): Promise<PositionResponseDto>;
  closePosition(id: string, dto: ClosePositionDto, mode?: Mode): Promise<PositionResponseDto>;
  delete(id: string, mode?: Mode): Promise<void>;
  /** Count positions — used for pagination totals. */
  count(query: Omit<PositionListQueryDto, 'limit' | 'cursor'>): Promise<number>;
}
export {};
//# sourceMappingURL=positions.repository.d.ts.map
