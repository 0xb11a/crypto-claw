import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditRepository } from './audit.repository.js';
import { canonicalJson } from './canonical-json.js';
import { redactString } from '@cclaw/logger';

/** Input shape for AuditService.write — caller supplies raw body. */
export interface AuditWriteInput {
  ts: string;
  identity: string;
  role: string;
  method: string;
  path: string;
  /** Raw request body (object, not stringified). */
  body: unknown;
  status: number;
  latencyMs: number;
  errorKind?: string;
}

/**
 * Audit service — computes body_sha256 and body_redacted, then persists
 * the audit row via AuditRepository (ADR-0018).
 *
 * sha256 is computed over the canonicalized body (sorted keys) so that
 * object-key ordering doesn't produce different hashes for identical content.
 *
 * body_redacted is the string-level redacted version of JSON.stringify(body)
 * using libs/logger's redactor patterns (no new patterns added in P1a).
 *
 * **`path` convention:**
 * - HTTP handlers: path = the HTTP URL path (e.g. `/v1/orders/abc/execute`).
 * - Worker/background jobs: path uses the `'worker:'` prefix to distinguish
 *   from HTTP audit entries. Format: `'worker:<queue-name>:<resource-id>'`.
 *   Example: `'worker:execute-order:order-abc-123'`.
 *   Postmortem query: `SELECT * FROM service_audit WHERE path LIKE 'worker:%'`.
 */
@Injectable()
export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  async write(input: AuditWriteInput): Promise<void> {
    const canonical = canonicalJson(input.body);
    const bodySha256 = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const bodyRedacted = input.body != null ? redactString(JSON.stringify(input.body)) : undefined;

    await this.repository.create({
      ts: input.ts,
      identity: input.identity,
      role: input.role,
      method: input.method,
      path: input.path,
      bodySha256,
      bodyRedacted,
      status: input.status,
      latencyMs: input.latencyMs,
      errorKind: input.errorKind,
    });
  }
}
