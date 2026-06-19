#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Homelander — IS24 Auto-Apply Setup
# One command to set up everything: Chrome, config, cron, deps.
# Run:  bash setup.sh
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ROOT="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$ROOT/config"
DATA_DIR="$ROOT/data"

echo -e "${GREEN}═══ Homelander Setup ═══${NC}"
echo "Root: $ROOT"
echo ""

# ── 1. Prerequisites ─────────────────────────────────────────────
echo -e "${YELLOW}[1/5] Checking prerequisites...${NC}"

fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }

command -v node   >/dev/null 2>&1 || fail "Node.js not found. Install: brew install node"
command -v npm    >/dev/null 2>&1 || fail "npm not found."
[ -d "/Applications/Google Chrome.app" ] || fail "Chrome not found in /Applications"

NODE_VER=$(node -v | cut -d. -f1 | tr -d 'v')
[ "$NODE_VER" -ge 18 ] || fail "Node.js 18+ required (got $(node -v))"

echo -e "${GREEN}✓ Node $(node -v), Chrome found${NC}"

# ── 2. Install dependencies ──────────────────────────────────────
echo -e "${YELLOW}[2/5] Installing Node dependencies...${NC}"
cd "$ROOT"
npm install --no-audit --no-fund 2>&1 | tail -1
echo -e "${GREEN}✓ Dependencies installed${NC}"

# ── 3. Config ────────────────────────────────────────────────────
echo -e "${YELLOW}[3/5] Setting up config...${NC}"
mkdir -p "$CONFIG_DIR" "$DATA_DIR"

if [ -f "$CONFIG_DIR/autoapply.config.yaml" ]; then
    echo -e "${GREEN}✓ Config already exists: $CONFIG_DIR/autoapply.config.yaml${NC}"
else
    echo ""
    echo "─── Contact details ───"
    read -p "  Vorname: "             VORNAME
    read -p "  Nachname: "            NACHNAME
    read -p "  E-Mail: "              EMAIL
    read -p "  Telefon (optional): "  TELEFON
    read -p "  Straße: "              STRASSE
    read -p "  Hausnummer: "          HAUSNUMMER
    read -p "  PLZ: "                 PLZ
    read -p "  Ort: "                 ORT
    echo ""
    echo "─── Fredy connection ───"
    read -p "  Fredy URL [http://<your-server>:9998]: " FREDY_URL
    FREDY_URL=${FREDY_URL:-http://<your-server>:9998}
    read -p "  Fredy username [admin]: " FREDY_USER
    FREDY_USER=${FREDY_USER:-admin}
    read -sp "  Fredy password: "      FREDY_PASS; echo
    read -p "  Fredy job ID: "         FREDY_JOB

    cat > "$CONFIG_DIR/autoapply.config.yaml" << YAMLEOF
# Homelander autoapply configuration
fredy:
  base_url: "${FREDY_URL}"
  username: "${FREDY_USER}"
  password: "${FREDY_PASS}"
  job_id: "${FREDY_JOB}"

chrome:
  cdp_url: "http://localhost:9222"

polling:
  interval_seconds: 60

speed: "fast"

captcha:
  api_key: ""

contact:
  anrede: "Frau"
  vorname: "${VORNAME}"
  nachname: "${NACHNAME}"
  email: "${EMAIL}"
  telefon: "${TELEFON}"
  strasse: "${STRASSE}"
  hausnummer: "${HAUSNUMMER}"
  plz: "${PLZ}"
  ort: "${ORT}"
  einzug: "ab sofort"
  personen: "Einpersonenhaushalt"
  haustiere: "Nein"
  beschaeftigung: "Angestellte:r"
  einkommen: "3.500 - 5.000 €"
  unterlagen: "Vorhanden"
YAMLEOF
    echo -e "${GREEN}✓ Config created${NC}"
fi

# Message template
if [ ! -f "$CONFIG_DIR/message.txt" ]; then
    cat > "$CONFIG_DIR/message.txt" << 'MSGEOF'
Hallo,

ich interessiere mich sehr für {{title}} und würde gerne einen
Besichtigungstermin vereinbaren.

Kurz zu mir:
- Berufstätig in unbefristeter Anstellung
- Nichtraucher, keine Haustiere
- Schufa-Auskunft und Gehaltsnachweise liegen bereit

Ich freue mich auf Ihre Rückmeldung.

Mit freundlichen Grüßen
{{name}}
MSGEOF
    echo -e "${GREEN}✓ Message template created: $CONFIG_DIR/message.txt${NC}"
else
    echo -e "${GREEN}✓ Message template exists${NC}"
fi

# ── 4. Chrome launchd (auto-start on reboot) ──────────────────────
echo -e "${YELLOW}[4/5] Setting up Chrome auto-start...${NC}"
PLIST_SRC="$ROOT/platform/macos/com.homelander.chrome.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.homelander.chrome.plist"

if [ -f "$PLIST_SRC" ]; then
    mkdir -p "$HOME/Library/LaunchAgents"
    cp "$PLIST_SRC" "$PLIST_DST"
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load "$PLIST_DST" 2>/dev/null || true
    echo -e "${GREEN}✓ Chrome launchd plist installed${NC}"
else
    echo -e "${YELLOW}⚠ com.homelander.chrome.plist not found — skipping${NC}"
    echo "  Start Chrome manually: open -a 'Google Chrome' --args --remote-debugging-port=9222"
fi

# ── 5. Test & next steps ──────────────────────────────────────────
echo -e "${YELLOW}[5/5] Running dry-run test...${NC}"

# Quick connectivity test
echo "  Testing Fredy..."
if curl -sf --connect-timeout 5 "$FREDY_URL" >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓ Fredy reachable${NC}"
else
    echo -e "  ${YELLOW}⚠ Fredy not reachable — is it running?${NC}"
fi

echo "  Testing Chrome CDP..."
if curl -sf http://localhost:9222/json/version >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓ Chrome CDP active${NC}"
else
    echo -e "  ${YELLOW}⚠ Chrome CDP not reachable. Start Chrome with:${NC}"
    echo "     open -a 'Google Chrome' --args --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug"
fi

# Dry run
echo "  Running dry-run..."
cd "$ROOT"
DRY_RUN=1 node src/index.js 2>&1 | tail -3

echo ""
echo -e "${GREEN}═══ Setup complete ═══${NC}"
echo ""
echo "Next steps:"
echo "  1. Ensure Chrome is running with remote debugging (port 9222)"
echo "  2. Set up the cron job to run every minute:"
echo "       hermes cronjob create --name homelander --schedule 'every 1m' \\"
echo "         --script autoapply.sh --no-agent --workdir $ROOT"
echo "     Or manually (macOS cron):"
echo "       crontab -l | { cat; echo '* * * * * cd $ROOT && /opt/homebrew/bin/node src/index.js >> autoapply.log 2>&1'; } | crontab -"
echo "  3. Monitor logs: tail -f $ROOT/autoapply.log"
echo "  4. Wait 24-48h before first real run (IS24 cooldown for new accounts)"
