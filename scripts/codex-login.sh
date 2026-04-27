#!/bin/bash
# ============================================================
# codex-login.sh — Authenticate with OpenAI Codex OAuth
#
# Uses OpenClaw's native openai-codex provider (ChatGPT subscription).
# This enables flat-fee GPT-5.5 / GPT-5.4 / GPT-5.4-mini access (no per-token billing).
#
# Usage:
#   docker compose exec crypto-claw bash /home/openclaw/crypto-claw/scripts/codex-login.sh
#
# Prerequisites:
#   - ChatGPT Plus, Pro, or Team subscription
#
# After login, restart the container to activate the Codex OAuth provider.
# ============================================================

set -euo pipefail

# Check current auth status
if openclaw models auth status --provider openai-codex --quiet 2>/dev/null; then
  echo "OpenAI Codex OAuth: already authenticated."
  echo ""
  echo "To re-authenticate:"
  echo "  openclaw models auth login --provider openai-codex"
  exit 0
fi

echo "Starting OpenAI Codex OAuth login..."
echo ""

openclaw models auth login --provider openai-codex

if openclaw models auth status --provider openai-codex --quiet 2>/dev/null; then
  echo ""
  echo "Login successful. Restart the container to activate:"
  echo "  docker compose restart crypto-claw"
else
  echo ""
  echo "ERROR: Auth not verified. Check your subscription and try again."
  exit 1
fi
