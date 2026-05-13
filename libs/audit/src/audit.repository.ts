import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
import type { AuditQueryDto } from './dto/audit-query.dto.js';
import type { ServiceAuditEntryDto } from './dto/audit-response.dto.js';

/** Shape of a single audit record write. */
export interface CreateAuditInput {
  ts: string;
  identity: string;
  role: string;
  method: string;
  path: string;
  bodySha256: string;
  bodyRedacted?: string;
  status: number;
  latencyMs: number;
  errorKind?: string;
}

/**
 * Audit repository — reads and writes the service_audit table (SPEC §9.5, ADR-0018).
 *
 * Read methods ship in P1b (findMany, count, findById).
 * Keyset pagination: cursor is the last seen `id` from a previous page;
 * results are ordered by `ts` DESC then `id` DESC.
 */
@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Write a single audit row. Throws on Prisma error (caller handles). */
  async create(input: CreateAuditInput): Promise<void> {
    await this.prisma.serviceAudit.create({
      data: {
        ts: input.ts,
        identity: input.identity,
        role: input.role,
        method: input.method,
        path: input.path,
        bodySha256: input.bodySha256,
        bodyRedacted: input.bodyRedacted ?? null,
        status: input.status,
        latencyMs: input.latencyMs,
        errorKind: input.errorKind ?? null,
      },
    });
  }

  private mapRow(row: {
    id: string;
    ts: string;
    identity: string;
    role: string;
    method: string;
    path: string;
    bodySha256: string;
    bodyRedacted: string | null;
    status: number;
    latencyMs: number;
    errorKind: string | null;
  }): ServiceAuditEntryDto {
    return {
      id: row.id,
      ts: row.ts,
      identity: row.identity,
      role: row.role,
      method: row.method,
      path: row.path,
      body_sha256: row.bodySha256,
      body_redacted: row.bodyRedacted ?? undefined,
      status: row.status,
      latency_ms: row.latencyMs,
      error_kind: row.errorKind ?? undefined,
    };
  }

  private buildWhere(query: Omit<AuditQueryDto, 'limit' | 'cursor'>) {
    return {
      ...(query.identity ? { identity: query.identity } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.pathContains ? { path: { contains: query.pathContains } } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.since || query.until
        ? {
            ts: {
              ...(query.since ? { gte: query.since } : {}),
              ...(query.until ? { lte: query.until } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * Keyset paginated query ordered by ts DESC, id DESC.
   *
   * When cursor is provided, it is the last seen `id` from the previous page.
   * We implement this by fetching items where id < cursor (with the same sort order).
   */
  async findMany(query: AuditQueryDto): Promise<ServiceAuditEntryDto[]> {
    const limit = Math.min(query.limit ?? 100, 1000);
    const where = {
      ...this.buildWhere(query),
      // Keyset pagination: id less than cursor means "earlier in sort order" (id DESC)
      ...(query.cursor ? { id: { lt: query.cursor } } : {}),
    };

    const rows = await this.prisma.serviceAudit.findMany({
      where,
      take: limit,
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
    });

    return rows.map((r) => this.mapRow(r));
  }

  /** Count audit rows matching query (without cursor/limit). */
  async count(query: Omit<AuditQueryDto, 'limit' | 'cursor'>): Promise<number> {
    return this.prisma.serviceAudit.count({ where: this.buildWhere(query) });
  }

  /** Get a single audit entry by ID. */
  async findById(id: string): Promise<ServiceAuditEntryDto> {
    const row = await this.prisma.serviceAudit.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Audit entry ${id} not found`);
    return this.mapRow(row);
  }
}
