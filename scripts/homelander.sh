#!/usr/bin/env bash
# homelander — daemon mode: poll forever, process listings, Ctrl+C to stop.
# Usage: ./scripts/homelander.sh [--dry-run]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# ── Ensure Chrome is running ──────────────────────────────────────
if ! curl -sf http://localhost:9222/json/version >/dev/null 2>&1; then
    echo "🚀 Starting Chrome with remote debugging..."
    open -a "Google Chrome" --args \
        --remote-debugging-port=9222 \
        --user-data-dir=/tmp/chrome-debug \
        --profile-directory=Default \
        --remote-allow-origins=*
    echo "⏳ Waiting for Chrome CDP..."
    for i in $(seq 1 15); do
        curl -sf http://localhost:9222/json/version >/dev/null 2>&1 && break
        sleep 1
    done
fi

# ── Run ───────────────────────────────────────────────────────────
cd "$ROOT"
if [ "$DRY_RUN" -eq 1 ]; then
    DRY_RUN=1 exec /opt/homebrew/bin/node src/index.js --watch
else
    exec /opt/homebrew/bin/node src/index.js --watch
fi
