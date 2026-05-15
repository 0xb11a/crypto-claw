/**
 * Unit tests for reminder-notes.ts pure functions (SPEC §14, DoD §A).
 *
 * No I/O, no DI. Tests the getLastReminder / buildReminderNotes / shouldSendReminder
 * round-trip faithfully mirroring the legacy `scripts/track-multisig.js:142-154`
 * behavior (DoD §I).
 *
 * Covers:
 *   getLastReminder:
 *     - null/undefined notes → 0
 *     - notes with no marker → 0
 *     - notes with valid marker → correct timestamp
 *     - marker embedded in longer notes string
 *
 *   buildReminderNotes:
 *     - null/undefined existing → "last_reminder:<now>"
 *     - existing notes with no marker → appends marker
 *     - existing notes with old marker → replaces it
 *     - stripping and re-inserting is clean (no double spaces)
 *
 *   shouldSendReminder:
 *     - first call (no marker, now=anything) → true (elapsed=now-0 >= 30min)
 *     - last reminder just sent → false
 *     - just past 30 min interval → true
 *     - custom intervalMs
 *
 *   Round-trip: buildReminderNotes → getLastReminder → shouldSendReminder
 *
 * DoD §A — tests fail before implementation, pass after.
 * DoD §I — bug-for-bug parity with legacy setLastReminder.
 */
import { describe, it, expect } from 'vitest';
import { getLastReminder, buildReminderNotes, shouldSendReminder } from './reminder-notes.js';

const THIRTY_MIN_MS = 30 * 60 * 1000;
const NOW = 1_700_000_000_000; // arbitrary fixed ms timestamp

// ---------------------------------------------------------------------------
// getLastReminder
// ---------------------------------------------------------------------------

describe('getLastReminder', () => {
  it('returns 0 for null notes', () => {
    expect(getLastReminder(null)).toBe(0);
  });

  it('returns 0 for undefined notes', () => {
    expect(getLastReminder(undefined)).toBe(0);
  });

  it('returns 0 for empty string notes', () => {
    expect(getLastReminder('')).toBe(0);
  });

  it('returns 0 when no last_reminder marker present', () => {
    expect(getLastReminder('some notes without marker')).toBe(0);
  });

  it('extracts timestamp from last_reminder marker', () => {
    const notes = `last_reminder:${NOW}`;
    expect(getLastReminder(notes)).toBe(NOW);
  });

  it('extracts marker embedded after other text', () => {
    const notes = `approved by alice last_reminder:${NOW}`;
    expect(getLastReminder(notes)).toBe(NOW);
  });

  it('extracts marker embedded before other text', () => {
    const notes = `last_reminder:${NOW} other notes`;
    expect(getLastReminder(notes)).toBe(NOW);
  });

  it('returns integer (parseInt result)', () => {
    const result = getLastReminder(`last_reminder:${NOW}`);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildReminderNotes
// ---------------------------------------------------------------------------

describe('buildReminderNotes', () => {
  it('returns "last_reminder:<now>" for null existing notes', () => {
    const result = buildReminderNotes(null, NOW);
    expect(result).toBe(`last_reminder:${NOW}`);
  });

  it('returns "last_reminder:<now>" for undefined existing notes', () => {
    const result = buildReminderNotes(undefined, NOW);
    expect(result).toBe(`last_reminder:${NOW}`);
  });

  it('returns "last_reminder:<now>" for empty string notes', () => {
    const result = buildReminderNotes('', NOW);
    expect(result).toBe(`last_reminder:${NOW}`);
  });

  it('appends marker to notes that had no marker', () => {
    const result = buildReminderNotes('some existing note', NOW);
    expect(result).toBe(`some existing note last_reminder:${NOW}`);
  });

  it('replaces old marker with new timestamp', () => {
    const OLD = NOW - THIRTY_MIN_MS;
    const notes = `some text last_reminder:${OLD}`;
    const result = buildReminderNotes(notes, NOW);
    expect(result).toContain(`last_reminder:${NOW}`);
    expect(result).not.toContain(`last_reminder:${OLD}`);
  });

  it('does not introduce double spaces when replacing marker at end', () => {
    const OLD = NOW - THIRTY_MIN_MS;
    const notes = `some text last_reminder:${OLD}`;
    const result = buildReminderNotes(notes, NOW);
    expect(result).not.toContain('  ');
  });

  it('stripped content is trimmed (no leading/trailing whitespace)', () => {
    const notes = `  last_reminder:${NOW - 1000}  `;
    const result = buildReminderNotes(notes, NOW);
    expect(result).not.toMatch(/^\s/);
    expect(result).not.toMatch(/\s$/);
  });

  it('getLastReminder round-trips correctly after build', () => {
    const result = buildReminderNotes('prior note', NOW);
    expect(getLastReminder(result)).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// shouldSendReminder
// ---------------------------------------------------------------------------

describe('shouldSendReminder', () => {
  it('returns true when no marker (first call, elapsed=now-0 is huge)', () => {
    expect(shouldSendReminder(null, NOW)).toBe(true);
  });

  it('returns false when reminder was just sent (elapsed < 30 min)', () => {
    const notes = buildReminderNotes(null, NOW - 1000); // 1 second ago
    expect(shouldSendReminder(notes, NOW)).toBe(false);
  });

  it('returns true exactly at 30-minute boundary', () => {
    const notes = buildReminderNotes(null, NOW - THIRTY_MIN_MS);
    expect(shouldSendReminder(notes, NOW)).toBe(true);
  });

  it('returns true when one millisecond past the interval', () => {
    const notes = buildReminderNotes(null, NOW - THIRTY_MIN_MS - 1);
    expect(shouldSendReminder(notes, NOW)).toBe(true);
  });

  it('returns false when one millisecond before the interval', () => {
    const notes = buildReminderNotes(null, NOW - THIRTY_MIN_MS + 1);
    expect(shouldSendReminder(notes, NOW)).toBe(false);
  });

  it('respects custom intervalMs parameter', () => {
    const fiveMin = 5 * 60 * 1000;
    const notes = buildReminderNotes(null, NOW - fiveMin);
    expect(shouldSendReminder(notes, NOW, fiveMin)).toBe(true);
    expect(shouldSendReminder(notes, NOW, fiveMin + 1)).toBe(false);
  });

  it('round-trip: build → should NOT send immediately after build', () => {
    const notes = buildReminderNotes(null, NOW);
    // Reminder was "just built" at NOW — should not send again at NOW
    expect(shouldSendReminder(notes, NOW)).toBe(false);
  });

  it('round-trip: build → should send after interval passes', () => {
    const notes = buildReminderNotes(null, NOW);
    expect(shouldSendReminder(notes, NOW + THIRTY_MIN_MS)).toBe(true);
  });

  it('handles notes with extra text (getLastReminder extracts marker)', () => {
    const notes = `approved by bob last_reminder:${NOW - THIRTY_MIN_MS - 500} confirmed`;
    expect(shouldSendReminder(notes, NOW)).toBe(true);
  });
});
