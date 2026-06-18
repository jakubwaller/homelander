# Homelander — IS24 Auto-Apply Bot (Build Plan)

## TL;DR

One Python script (`homelander.py`). Polls Fredy for new IS24 listings. Drives your real Chrome via CDP. Sends your message. Private GitHub repo. One command to set up, one to run.

---

## Prerequisites

Before building, these must exist:

| What | Status |
|---|---|
| **Fredy running on VPS** | ✅ Deployed at `http://your-server-ip:9998` (credentials in `private/config.yaml`) |
| **IS24 MieterPlus account** | You have this — gives early access to listings |
| **Chrome on Mac** with IS24 logged in | Browser already has your session cookies |
| **Hermes on Mac** | Installed |
| **Private GitHub repo** | ✅ `github.com/B1Z0N/homelander` |

---

## Architecture

```
Fredy (VPS, your-server-ip:9998)          Homelander (your Mac)
         │                                       │
         ├─ Monitors IS24 searches             │
         │   (CloakBrowser stealth Chromium)        │
         ├─ Stores listings in SQLite              │
         │                                       │
         │   poll every 60s (HTTP GET)            │
         │◄───────────────────────────────────────┤
         │   GET /api/listings/table              │
         │   ?providerFilter=immoscout            │
         │   &page=1&pageSize=20                  │
         │   (with Fredy session cookie)          │
         │                                       │
         ├─ Returns listing JSON ────────────────►│
         │                                       │
         │                           state.json (gitignored)
         │                           ├─ seen_ids: [already sent]
         │                           └─ sent_at: {id: timestamp}
         │                                       │
         │                           File lock prevents concurrent runs
         │                           (lockfile with PID, stale after 120s)
         │                                       │
         │                           For each NEW listing:
         │                           1. Connect to YOUR Chrome (CDP port 9222)
         │                           2. /expose/ID#/basicContact/email
         │                           3. Type message with human timing
         │                           4. Click send
         │                           5. Update state.json
         │                           6. Log to stdout → Telegram
```

### Why real Chrome solves the JS fingerprint problem

No headless. No stealth plugin. No CloakBrowser needed. Your actual Chrome with your IS24 cookies, your MieterPlus session, your residential IP, your genuine canvas/WebGL/fonts fingerprint. Datadome sees you browsing normally — indistinguishable from manual use.

---

## What You Do (5 steps, ~5 min)

### Step 1 — Look up Fredy

Open `http://your-server-ip:9998` in your browser. Login. Locate the job for Hamburg immo24 already there.

### Step 2 — Clone and set up the bot

```bash
git clone git@github.com:B1Z0N/homelander.git
cd homelander
python3 -m venv venv
source venv/bin/activate
pip install -e .
```

Repo already has: `homelander.py` (skeleton), `config.example.yaml`, `message.example.txt`, `pyproject.toml`, `scripts/run.sh`. All private files (config, message, state) go in `private/` (gitignored).

### Step 3 — Edit your config

**config.yaml** (copy from `config.example.yaml`, gitignored):

```yaml
fredy:
  base_url: "http://your-server-ip:9998"
  username: "admin"
  password: "your-fredy-password"

chrome:
  executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  user_data_dir: "/Users/nick/Library/Application Support/Google/Chrome"
  profile_directory: "Default"
  cdp_port: 9222

polling:
  interval_seconds: 60
  max_sends_per_run: 3       # safety cap — never more than 3 per tick

state_file: "private/is24_state.json"
message_file: "private/message.txt"
```

**message.txt** (gitignored):

```
Hallo,

ich interessiere mich sehr für diese Wohnung und würde gerne einen Besichtigungstermin vereinbaren.

Kurz zu mir:
- Softwareentwickler in unbefristeter Anstellung
- Nichtraucher, keine Haustiere
- Schufa-Auskunft, Gehaltsnachweise und Mietzahlungsbestätigung liegen bereit

Ich freue mich auf Ihre Rückmeldung.

Mit freundlichen Grüßen
Max Mustermann
```

### Step 4 — Launch Chrome with debugging

Before running the bot, Chrome must be running with remote debugging enabled:

```bash
# Close all Chrome windows first, then:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="/Users/nick/Library/Application Support/Google/Chrome" \
  --profile-directory="Default"
```

This launches YOUR Chrome with YOUR profile, YOUR cookies, YOUR MieterPlus session. The bot connects to it via CDP (Chrome DevTools Protocol) and drives it.

### Step 5 — Run

```bash
cd ~/homelander
source venv/bin/activate
python homelander.py
```

Or as a Hermes cron job (recommended for 24/7):

```bash
hermes cron create \
  --command "cd ~/homelander && ./venv/bin/python homelander.py" \
  --schedule "60s" \
  --name "homelander"
```

Hermes captures stdout → delivers to your Telegram. "SENT | title | 850€ | address". Silent when nothing new — no spam.

---

## What the Script Does (one loop iteration)

```
1. Authenticate with Fredy (POST /api/login → get session cookie)
2. GET /api/listings/table?providerFilter=immoscout&page=1&pageSize=20
3. Parse response → extract {id, title, price, link, address}
4. Load state.json → diff against seen_ids → find genuinely new ones
5. If none new → print nothing, exit 0
6. For each new listing (capped at max_sends_per_run):
   a. Connect to Chrome via CDP (port 9222)
   b. page.goto("https://www.immobilienscout24.de/expose/ID#/basicContact/email")
   c. Check for block ("Roboter", "Sicherheitsprüfung", 401)
      → if blocked: print "BLOCKED | ID | reason", mark in state, skip
   d. Wait for textarea (with timeout — some listings disable contact form)
      → if no textarea: print "NO_FORM | ID", skip
   e. Type message with random delay (50-200ms per character)
   f. Click "Anfrage senden" button
   g. Print: "SENT | ID | title | price€ | address"
   h. Update state.json immediately (atomic write)
7. Print summary: "Done: X sent, Y skipped, Z blocked"
```

---

## Error Handling

| What happens | Script behavior | You see |
|---|---|---|
| Fredy unreachable | Exit with error | Hermes: "homelander FAILED: connection refused" |
| Fredy auth fails | Exit with error | "AUTH_FAILED — check username/password" |
| Chrome not running on CDP port | Exit with error | "CDP_FAILED — launch Chrome with --remote-debugging-port" |
| IS24 returns 401/blocked | Skip listing, log it | "BLOCKED | ID" |
| Contact form missing | Skip listing, log it | "NO_FORM | ID" |
| Already sent (state.json) | Skip silently | Nothing — it already worked |
| CAPTCHA appears | Skip listing, take no action | "BLOCKED | ID" — manual follow-up needed |
| Concurrent run detected | Exit with error | "LOCKED — another instance is running" |
| Anything else crashes | Exception logged | Full traceback in Telegram |

---

## What's NOT in the Prototype

| Feature | Why omitted | When |
|---|---|---|
| AI CAPTCHA solving | Not needed — real Chrome passes fingerprint check | Phase 2 if ever triggered |
| Telegram screenshot of CAPTCHA | Keep prototype lean — manual follow-up for rare blocks | Phase 2 |
| Headless mode | Breaks fingerprint — visible Chrome IS the strategy | Maybe never |
| Daily summary | Per-run output is sufficient | Phase 2 |
| Multi-platform (Kleinanzeigen, etc.) | IS24 first, prove concept | Phase 2+ |
| Auto-launch Chrome | User controls browser lifecycle — safer | Phase 2 |

---

## JS Fingerprint Strategy

| Mode | Datadome risk |
|---|---|
| **Default** — Real Chrome, real profile, visible window, residential IP | Near zero |
| Headless + CloakBrowser | Low — same as Fredy's scraping, but why bother when real Chrome is free |

Prototype uses default. No code spent on evasion. The architecture IS the evasion.

---

## Input Needed From You

| # | What | Where |
|---|---|---|
| 1 | IS24 saved search URL | Paste into Fredy UI → create job |
| 2 | Message to landlords | Write in `message.txt` (or I draft, you approve) |
| 3 | Chrome profile path | Run `chrome://version` in Chrome, copy "Profile Path" |

---

## Success Criteria

1. Fredy detects IS24 listing → Homelander polls → sends within 90 seconds
2. Never double-sends (state.json dedup)
3. Runs from one command or Hermes cron
4. Entire repo versioned in private GitHub from first commit
5. Real Chrome fingerprint — no Datadome challenges during normal operation
