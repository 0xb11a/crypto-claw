/**
 * Canonical JSON serialisation — keys sorted recursively.
 *
 * Used by AuditService to produce a stable sha256 of the request body
 * regardless of insertion order of object keys (ADR-0018).
 *
 * Edge cases handled:
 * - null, undefined → serialised as expected by JSON.stringify
 * - arrays preserve element order
 * - nested objects have their keys sorted
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedReplacer(value));
}

function sortedReplacer(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortedReplacer);

  // Object — sort keys
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortedReplacer((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
