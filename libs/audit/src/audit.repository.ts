import { Injectable } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';

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
 * Audit repository — writes to the service_audit table (SPEC §9.5, ADR-0018).
 *
 * Read methods (GET /v1/system/audit) are deferred to P1b.
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
}
