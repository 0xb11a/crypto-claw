#!/bin/bash
# ============================================================
# memory-backup.sh — Git Auto-Commit for CryptoClaw Agent Memory
#
# Backs up agent memory (markdown files only) to a private git repo.
# This covers:
#   - MEMORY.md (curated patterns and lessons)
#   - memory/*.md (daily logs)
#
# Does NOT back up wallet data (SQLite) — that lives in data/
# and should be backed up separately (e.g., sqlite3 .backup).
#
# Symlink architecture: Sentinel and Executor memory/ dirs are
# symlinked to Research's workspace. All three agents' writes land
# in the same directory, so this single backup job covers everything.
#
# Usage:
#   ./memory-backup.sh /path/to/workspace
#
# Runs as a background shell loop in the container (entrypoint.sh),
# or as a system cron job for bare-metal installs:
#   */15 * * * * /path/to/memory-backup.sh /path/to/workspace
# ============================================================

set -euo pipefail

WORKSPACE_DIR="${1:-$HOME/.openclaw/agents/research/workspace}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LOG_PREFIX="[memory-backup $TIMESTAMP]"

# Check workspace exists
if [ ! -d "$WORKSPACE_DIR" ]; then
  echo "$LOG_PREFIX ERROR: Workspace not found at $WORKSPACE_DIR"
  exit 1
fi

cd "$WORKSPACE_DIR"

# Emit heartbeat so Observer can detect if this loop stops.
# Runs at the start of every invocation — a stale `system/memory-backup`
# heartbeat means this script is no longer being called (container issue,
# cron stopped, etc.). Guarded to not fail the backup if SAFE_ID is unset.
if [ -n "${SAFE_ID:-}" ]; then
  SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "$0")" && pwd)}"
  if [ -f "$SCRIPTS_DIR/db-query.js" ]; then
    node "$SCRIPTS_DIR/db-query.js" update-heartbeat --agent system --check memory-backup >/dev/null 2>&1 || true
  fi
fi

# Repair repos initialized without .gitignore (entrypoint.sh bug pre-v1.1)
if [ -d ".git" ] && [ ! -f ".gitignore" ]; then
  cat > .gitignore << 'GITIGNORE'
*
!.gitignore
!MEMORY.md
!memory/
!memory/*.md
GITIGNORE
  git rm -r --cached --quiet . 2>/dev/null || true
  git add -A
  git commit -q -m "auto: add .gitignore, clean tracked files" 2>/dev/null || true
  echo "$LOG_PREFIX Repaired: created .gitignore and cleaned tracked files"
fi

# Ensure git is initialized
if [ ! -d ".git" ]; then
  echo "$LOG_PREFIX Initializing git repository..."
  git init
  # Only track markdown memory files
  cat > .gitignore << 'GITIGNORE'
# Only track agent memory (markdown files)
# Wallet data (SQLite) is in data/ outside this directory
*
!.gitignore
!MEMORY.md
!memory/
!memory/*.md
GITIGNORE
  git add -A
  git commit -m "Initial CryptoClaw agent memory"
fi

# Check for changes in tracked files
CHANGES=$(git status --porcelain)

if [ -z "$CHANGES" ]; then
  echo "$LOG_PREFIX No changes to commit"
  exit 0
fi

# Count what changed
DAILY_LOG_CHANGES=$(echo "$CHANGES" | grep -c "memory/" || true)
MEMORYMD_CHANGES=$(echo "$CHANGES" | grep -c "MEMORY.md" || true)

echo "$LOG_PREFIX Changes detected: ${DAILY_LOG_CHANGES} daily logs, ${MEMORYMD_CHANGES} MEMORY.md"

# Build commit message
COMMIT_PARTS=()
if [ "$MEMORYMD_CHANGES" -gt 0 ]; then
  COMMIT_PARTS+=("MEMORY.md")
fi
if [ "$DAILY_LOG_CHANGES" -gt 0 ]; then
  COMMIT_PARTS+=("${DAILY_LOG_CHANGES} daily log(s)")
fi

if [ ${#COMMIT_PARTS[@]} -eq 0 ]; then
  echo "$LOG_PREFIX No memory files changed — skipping"
  exit 0
fi

COMMIT_MSG="auto: update $(IFS=', '; echo "${COMMIT_PARTS[*]}") [$TIMESTAMP]"

# Stage and commit
git add MEMORY.md memory/*.md 2>/dev/null || true
git commit -m "$COMMIT_MSG" --quiet

echo "$LOG_PREFIX Committed: $COMMIT_MSG"

# Sync with remote if configured
# Each deployment pushes to its own branch: memory/<SAFE_ID>
# Local workspace is the source of truth — force-push to overwrite remote.
if git remote get-url origin &>/dev/null; then
  MEMORY_BRANCH="memory/${SAFE_ID:-default}"
  SYNC_STATUS_FILE=".git/memory-sync-status"

  # --- Self-healing preamble (run before every sync attempt) ---

  # Abort stuck rebase from interrupted operations
  if [ -d ".git/rebase-merge" ] || [ -d ".git/rebase-apply" ]; then
    echo "$LOG_PREFIX Aborting stuck rebase..."
    git rebase --abort 2>/dev/null || true
  fi

  # Fix detached HEAD or wrong branch
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
  if [ "$CURRENT_BRANCH" != "$MEMORY_BRANCH" ]; then
    echo "$LOG_PREFIX Switching to branch $MEMORY_BRANCH (was: $CURRENT_BRANCH)"
    git checkout -B "$MEMORY_BRANCH" --quiet 2>/dev/null || true
  fi

  # Reset dirty index from interrupted operations
  git reset --quiet 2>/dev/null || true

  # --- Force-push sync (local is authoritative) ---

  PUSH_ERR=$(git push origin "HEAD:refs/heads/$MEMORY_BRANCH" --force --quiet 2>&1) && {
    echo "$LOG_PREFIX Pushed to $MEMORY_BRANCH"
    # Record success
    printf '{"last_push":"%s","consecutive_failures":0,"last_error":null}\n' "$TIMESTAMP" > "$SYNC_STATUS_FILE"
  } || {
    # Read previous failure count
    PREV_FAILURES=0
    if [ -f "$SYNC_STATUS_FILE" ]; then
      PREV_FAILURES=$(grep -o '"consecutive_failures":[0-9]*' "$SYNC_STATUS_FILE" | grep -o '[0-9]*' || echo "0")
    fi
    FAILURES=$((PREV_FAILURES + 1))

    # Escalate from WARNING to ERROR after 3+ consecutive failures
    if [ "$FAILURES" -ge 3 ]; then
      echo "$LOG_PREFIX ERROR: Push failed ($FAILURES consecutive) — $PUSH_ERR"
    else
      echo "$LOG_PREFIX WARNING: Push failed ($FAILURES consecutive) — $PUSH_ERR"
    fi

    # Record failure
    SAFE_ERR=$(echo "$PUSH_ERR" | tr '"' "'")
    printf '{"last_push":null,"consecutive_failures":%d,"last_error":"%s"}\n' "$FAILURES" "$SAFE_ERR" > "$SYNC_STATUS_FILE"
  }
else
  echo "$LOG_PREFIX No remote configured — commit is local only"
  echo "$LOG_PREFIX To enable push: git remote add origin <your-private-repo-url>"
fi
