/**
 * reminder-notes.ts — Pure-function port of reminder-note helpers.
 *
 * Bug-for-bug port of `getLastReminder` and `setLastReminder` from
 * `scripts/track-multisig.js:142-154` (DoD §I — legacy unchanged).
 *
 * These functions parse/format a `last_reminder:<timestamp>` marker that is
 * embedded in receipt `notes` to track when the last pending-transaction
 * reminder was sent. This avoids spamming operators on every 5-minute cycle.
 *
 * No DI — pure functions, no side effects.
 */

/**
 * Extract the last_reminder timestamp (ms) from receipt notes.
 *
 * @param notes - Receipt notes string (may be null/undefined).
 * @returns Unix timestamp in ms, or 0 if no marker present.
 */
export function getLastReminder(notes: string | null | undefined): number {
  if (!notes) return 0;
  const match = /last_reminder:(\d+)/.exec(notes);
  return match ? parseInt(match[1] ?? '0', 10) : 0;
}

/**
 * Build updated notes with a refreshed last_reminder marker.
 *
 * Replaces any existing `last_reminder:*` token, or appends a new one.
 * Returns the new notes string (caller is responsible for writing it to DB).
 *
 * Bug-for-bug port of `scripts/track-multisig.js:setLastReminder`.
 *
 * @param existingNotes - Current notes string from the receipt row.
 * @param now - Current timestamp in ms.
 * @returns Updated notes string.
 */
export function buildReminderNotes(existingNotes: string | null | undefined, now: number): string {
  const existing = existingNotes ?? '';
  const stripped = existing.replace(/last_reminder:\d+/, '').trim();
  return `${stripped ? stripped + ' ' : ''}last_reminder:${now}`.trim();
}

/**
 * Determine whether a reminder should be sent.
 *
 * Returns true if at least `intervalMs` has elapsed since the last reminder.
 * Mirrors the check in `scripts/track-multisig.js:handlePending`.
 *
 * @param notes - Receipt notes string.
 * @param now - Current timestamp in ms.
 * @param intervalMs - Minimum interval between reminders (default: 30 min).
 */
export function shouldSendReminder(
  notes: string | null | undefined,
  now: number,
  intervalMs = 30 * 60 * 1000,
): boolean {
  return now - getLastReminder(notes) >= intervalMs;
}
