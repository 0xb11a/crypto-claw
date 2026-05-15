/**
 * notes-utils.ts — Sanitizer for position notes fields.
 *
 * Bug-for-bug port of `scripts/redact.js:sanitizeUntrusted` for use
 * in the NestJS positions module.
 *
 * Purpose: position notes can include strings from external sources (token
 * names, chain/protocol labels from DEXScreener / GoPlus) before they are
 * surfaced to an LLM agent. This sanitizer strips control characters, zero-
 * width chars, bidi overrides, and potential markup injection sequences, then
 * caps the length.
 *
 * This is a COPY, not a shared dep. DoD §I forbids touching the legacy script.
 *
 * Different concern from redact():
 *   redact()           — strips OUR secrets out of OUR strings (defensive).
 *   sanitizeUntrusted() — strips THEIR injection out of THEIR strings (offensive).
 *
 * Usage: called by `PositionsRepository.appendNote` to sanitize the existing
 * notes before concatenating a new marker, matching the legacy
 * `reconcile-positions.js:140`:
 *   `const existing = sanitizeUntrusted(position.notes ?? '', { maxLen: 800 });`
 *
 * DoD §I — byte-identical behaviour with `scripts/redact.js:sanitizeUntrusted`.
 * DoD §F — prevents notes from being used for log/prompt injection.
 */

// ---------------------------------------------------------------------------
// Regex patterns (ported verbatim from scripts/redact.js)
// ---------------------------------------------------------------------------

/** Control chars except \n (0A) and \t (09). */
const CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;
/** Zero-width chars. */
const ZERO_WIDTH = /[​-‍﻿⁠᠎]/g;
/** Bidi and RTL overrides. */
const BIDI_OVERRIDE = /[‪-‮⁦-⁩]/g;
/** Tag-like sequences that could close LLM markup. */
const CLOSING_TAG = /<\/?[a-zA-Z][^>]{0,200}>/g;
/** Markdown code fences. */
const CODE_FENCE = /```/g;

const DEFAULT_MAX_LEN = 64;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sanitize an untrusted external string before appending to position notes.
 *
 * Strips dangerous Unicode classes, potential markup injection sequences, and
 * caps length. Produces a string safe for LLM context.
 *
 * Bug-for-bug parity with `scripts/redact.js:sanitizeUntrusted` (DoD §I).
 *
 * @param str - Input from DEXScreener, GoPlus, existing DB notes, etc.
 * @param opts.maxLen - Length cap. Truncate beyond this. Default: 64.
 * @returns Sanitized string safe for notes fields and LLM context.
 */
export function sanitizeUntrusted(str: string | null | undefined, opts: { maxLen?: number } = {}): string {
  if (str === null || str === undefined) return '';
  if (typeof str !== 'string') str = String(str);

  const maxLen =
    Number.isFinite(opts.maxLen) && (opts.maxLen as number) > 0 ? (opts.maxLen as number) : DEFAULT_MAX_LEN;

  let result = str;

  // 1. Strip dangerous Unicode classes.
  result = result.replace(BIDI_OVERRIDE, '');
  result = result.replace(ZERO_WIDTH, '');
  result = result.replace(CONTROL_CHARS, '');

  // 2. Neutralize markup that could escape an LLM context boundary.
  result = result.replace(CLOSING_TAG, '');
  result = result.replace(CODE_FENCE, "'''");

  // 3. Cap length. Use a short, parseable marker so the model can see
  //    that truncation happened and won't read across the boundary.
  if (result.length > maxLen) {
    result = result.slice(0, maxLen) + '…[truncated]';
  }

  return result;
}

/**
 * Determine whether a drift marker should be appended to existing notes.
 *
 * Idempotency guard for the position-reconcile processor (DoD §E):
 * if the last line already contains a `recon_drift_*` marker with the same
 * driftPct rounded to 2 decimals AND the marker was written within the current
 * UTC hour, skip the append.
 *
 * This is a deliberate improvement over the legacy script's behaviour (which
 * appends on every cycle); the runbook documents this as a dedup guard.
 *
 * @param existingNotes - Current value of positions.notes (may be null).
 * @param driftPct - Drift percentage (rounded to 2 decimals).
 * @returns true if the marker should be appended, false if it is a duplicate.
 */
export function shouldAppendDriftMarker(existingNotes: string | null | undefined, driftPct: number): boolean {
  if (!existingNotes) return true;

  const driftPctStr = driftPct.toFixed(2);
  const markerPattern = `recon_drift_${driftPctStr}pct`;

  // Find the last line
  const lines = existingNotes.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';

  if (!lastLine.includes(markerPattern)) return true;

  // Extract timestamp from last line: format "[YYYY-MM-DDTHH:MM:SS]"
  const tsMatch = /^\[(\d{4}-\d{2}-\d{2}T\d{2})/.exec(lastLine);
  if (!tsMatch) return true;

  const existingHour = tsMatch[1]; // e.g. "2026-05-14T15"
  const currentHour = new Date().toISOString().slice(0, 13); // same format

  // If within the same UTC hour, it's a duplicate
  return existingHour !== currentHour;
}
