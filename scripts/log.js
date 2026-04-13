// ============================================================
// log.js — Structured Logging Helper
//
// Writes redacted, timestamped log lines to:
//   1. /tmp/openclaw/system.log (file — Observer agent reads this)
//   2. stderr (Docker container logs capture this)
//
// Daily rotation: system.log → system.YYYY-MM-DD.log
// Retention: 7 days of archives, auto-cleanup on rotation
// ============================================================

import { appendFileSync, renameSync, readdirSync, unlinkSync, statSync, mkdirSync } from 'fs';
import { join } from 'path';
import { redact } from './redact.js';

const LOG_DIR = '/tmp/openclaw';
const LOG_FILE = join(LOG_DIR, 'system.log');
const RETENTION_DAYS = 7;

let lastRotationDate = null;

/**
 * Ensure log directory exists (called once on first write).
 */
function ensureDir() {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

/**
 * Rotate log file if the date has changed since last rotation check.
 * Moves system.log → system.YYYY-MM-DD.log and cleans old archives.
 */
function rotateIfNeeded() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (lastRotationDate === today) return;

  lastRotationDate = today;

  // Rotate current log to dated archive (if it exists and has content)
  try {
    const stat = statSync(LOG_FILE);
    if (stat.size > 0) {
      // Use yesterday's date for the archive name
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const archiveName = join(LOG_DIR, `system.${yesterday}.log`);
      try {
        renameSync(LOG_FILE, archiveName);
      } catch {}
    }
  } catch {
    // File doesn't exist yet — no rotation needed
  }

  // Ensure system.log always exists after rotation (Observer reads this file)
  try {
    appendFileSync(LOG_FILE, '', { flag: 'a' });
  } catch {}

  // Clean archives older than RETENTION_DAYS
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    const files = readdirSync(LOG_DIR);
    for (const file of files) {
      if (file.startsWith('system.') && file.endsWith('.log') && file !== 'system.log') {
        const filePath = join(LOG_DIR, file);
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            unlinkSync(filePath);
          }
        } catch {}
      }
    }
  } catch {}
}

/**
 * Write a log entry.
 *
 * @param {'info'|'warn'|'error'|'critical'} level - Severity level
 * @param {string} source - Script or component name (e.g., 'process-order', 'executor-loop')
 * @param {string} message - Human-readable message (will be redacted)
 */
export function log(level, source, message) {
  ensureDir();
  rotateIfNeeded();

  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [${source}] ${redact(String(message))}\n`;

  // Write to log file (Observer agent reads this)
  try {
    appendFileSync(LOG_FILE, line);
  } catch {}

  // Write to stderr (Docker container logs)
  try {
    process.stderr.write(line);
  } catch {}
}

export default { log };
