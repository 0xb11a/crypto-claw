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
# Usage:
#   ./memory-backup.sh /path/to/workspace
#
# Designed to run as a cron job every 15 minutes:
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

# Push if remote is configured
if git remote get-url origin &>/dev/null; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  if git push origin "$BRANCH" --quiet 2>/dev/null; then
    echo "$LOG_PREFIX Pushed to origin/$BRANCH"
  else
    echo "$LOG_PREFIX WARNING: Push failed (will retry next run)"
  fi
else
  echo "$LOG_PREFIX No remote configured — commit is local only"
  echo "$LOG_PREFIX To enable push: git remote add origin <your-private-repo-url>"
fi
