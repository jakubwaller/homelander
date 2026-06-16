#!/bin/bash
# Homelander runner — called by Hermes cron job every 60s.
# Activates venv and runs the bot. Stdout → Hermes → Telegram.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d venv ]; then
    echo "ERROR: venv not found. Run: python3 -m venv venv && source venv/bin/activate && pip install -e ."
    exit 1
fi

source venv/bin/activate
exec python homelander.py "$@"
