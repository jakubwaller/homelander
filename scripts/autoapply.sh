#!/bin/bash
# Homelander cron watchdog — run this every 1m via cron or Hermes.
# Reads config, spawns the bot, logs to autoapply.log
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
/opt/homebrew/bin/node src/index.js >> autoapply.log 2>&1
