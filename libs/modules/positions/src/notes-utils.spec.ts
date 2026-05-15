/**
 * Unit tests for notes-utils.ts — parity tests against legacy redact.js.
 *
 * These tests verify byte-identical behaviour with `scripts/redact.js:sanitizeUntrusted`.
 * The cases mirror `tests/test-observer.js` redaction cases (SPEC §14, DoD §I).
 *
 * Also covers shouldAppendDriftMarker idempotency guard (DoD §E).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { sanitizeUntrusted, shouldAppendDriftMarker } from './notes-utils.js';

describe('sanitizeUntrusted (parity with scripts/redact.js)', () => {
  // -------------------------------------------------------------------------
  // Null / undefined inputs
  // -------------------------------------------------------------------------

  it('returns empty string for null', () => {
    expect(sanitizeUntrusted(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(sanitizeUntrusted(undefined)).toBe('');
  });

  it('converts non-string to string', () => {
    expect(sanitizeUntrusted(42 as unknown as string)).toBe('42');
  });

  // -------------------------------------------------------------------------
  // Control character stripping
  // -------------------------------------------------------------------------

  it('strips control chars (\\x00-\\x08)', () => {
    const input = 'hello\x00world\x07!';
    expect(sanitizeUntrusted(input, { maxLen: 200 })).toBe('helloworld!');
  });

  it('preserves \\n (newline)', () => {
    const input = 'line1\nline2';
    expect(sanitizeUntrusted(input, { maxLen: 200 })).toBe('line1\nline2');
  });

  it('preserves \\t (tab)', () => {
    const input = 'col1\tcol2';
    expect(sanitizeUntrusted(input, { maxLen: 200 })).toBe('col1\tcol2');
  });

  it('strips \\x0B (vertical tab)', () => {
    const input = 'a\x0Bb';
    expect(sanitizeUntrusted(input, { maxLen: 200 })).toBe('ab');
  });

  // -------------------------------------------------------------------------
  // Markup neutralization
  // -------------------------------------------------------------------------

  it('strips HTML-like closing tags', () => {
    const input = 'good <script>bad</script> good';
    const result = sanitizeUntrusted(input, { maxLen: 200 });
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('</script>');
  });

  it('replaces code fences with single quotes', () => {
    const input = '``` some code ```';
    const result = sanitizeUntrusted(input, { maxLen: 200 });
    expect(result).not.toContain('```');
    expect(result).toContain("'''");
  });

  // -------------------------------------------------------------------------
  // Length cap
  // -------------------------------------------------------------------------

  it('truncates at default maxLen (64) with truncation marker', () => {
    const input = 'a'.repeat(100);
    const result = sanitizeUntrusted(input);
    expect(result.length).toBeGreaterThan(64); // includes …[truncated]
    expect(result).toContain('…[truncated]');
    expect(result.startsWith('a'.repeat(64))).toBe(true);
  });

  it('truncates at custom maxLen=800', () => {
    const input = 'x'.repeat(1000);
    const result = sanitizeUntrusted(input, { maxLen: 800 });
    expect(result).toContain('…[truncated]');
    expect(result.startsWith('x'.repeat(800))).toBe(true);
  });

  it('does not truncate strings within limit', () => {
    const input = 'short string';
    expect(sanitizeUntrusted(input, { maxLen: 200 })).toBe('short string');
  });

  it('handles exactly-at-limit strings without truncation', () => {
    const input = 'a'.repeat(64);
    const result = sanitizeUntrusted(input);
    expect(result).toBe(input);
    expect(result).not.toContain('…[truncated]');
  });
});

// ---------------------------------------------------------------------------
// shouldAppendDriftMarker
// ---------------------------------------------------------------------------

describe('shouldAppendDriftMarker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true when existingNotes is null', () => {
    expect(shouldAppendDriftMarker(null, 2.5)).toBe(true);
  });

  it('returns true when existingNotes is empty', () => {
    expect(shouldAppendDriftMarker('', 2.5)).toBe(true);
  });

  it('returns true when no matching drift marker in last line', () => {
    const notes = '[2026-05-14T10:00:00] recon_drift_5.00pct direction=short db=100 onchain=95';
    // Different driftPct — should append
    expect(shouldAppendDriftMarker(notes, 2.5)).toBe(true);
  });

  it('returns false when same driftPct marker exists in last line within same UTC hour', () => {
    vi.useFakeTimers();
    // Set "now" to 2026-05-14T10:30:00Z — same hour as marker
    vi.setSystemTime(new Date('2026-05-14T10:30:00Z'));

    const notes = '[2026-05-14T10:00:00] recon_drift_2.50pct direction=short db=100 onchain=97';
    expect(shouldAppendDriftMarker(notes, 2.5)).toBe(false);
  });

  it('returns true when same driftPct marker exists but from a different UTC hour', () => {
    vi.useFakeTimers();
    // Set "now" to 2026-05-14T11:30:00Z — different hour
    vi.setSystemTime(new Date('2026-05-14T11:30:00Z'));

    const notes = '[2026-05-14T10:00:00] recon_drift_2.50pct direction=short db=100 onchain=97';
    expect(shouldAppendDriftMarker(notes, 2.5)).toBe(true);
  });

  it('checks only the last line (ignores older markers)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-14T10:30:00Z'));

    // Last line is different — should append even though older line matches
    const notes = [
      '[2026-05-14T10:00:00] recon_drift_2.50pct direction=short db=100 onchain=97',
      '[2026-05-14T09:00:00] recon_drift_3.00pct direction=over db=100 onchain=103',
    ].join('\n');
    expect(shouldAppendDriftMarker(notes, 2.5)).toBe(true); // last line = 3.00pct
  });
});
