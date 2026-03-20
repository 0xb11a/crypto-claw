#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "📦 Installing dev dependencies..."
cd "$REPO_ROOT" && npm install

echo "🔗 Installing pre-commit hook..."
ln -sf "$REPO_ROOT/hooks/pre-commit" "$REPO_ROOT/.git/hooks/pre-commit"
chmod +x "$REPO_ROOT/hooks/pre-commit"

echo "✅ Pre-commit hook installed. It will run on every git commit."
