# Homelander

Desktop app for automated IS24 apartment applications. Paste a search URL — Homelander finds listings and applies for you.

## Features

- **One-click setup** — guided wizard, no terminal needed
- **Auto-apply** — fills IS24 contact forms via your Chrome browser
- **Captcha solving** — automatic via 2captcha ($0.001/solve)
- **Smart pausing** — detects captcha walls and auto-pauses
- **Three speed modes** — fast, balanced, slow
- **Cross-platform** — macOS, Windows, Linux

## How it works

1. You paste an IS24 search URL
2. Homelander polls IS24's mobile API every 10 minutes for new listings
3. When new listings appear, it opens them in a background Chrome window
4. It fills the contact form with your details and submits
5. Captchas are solved automatically via 2captcha
6. Results appear in the live feed and history

No VPS. No terminal. Everything runs on your computer.

## Quick Start

### Prerequisites

- **Node.js 20+** ([nodejs.org](https://nodejs.org))
- **Chrome** — bundled automatically via `puppeteer` (npm install handles it)
- **2captcha account** ([2captcha.com](https://2captcha.com)) — ~$3 covers hundreds of applications

### Install

```bash
git clone https://github.com/B1Z0N/homelander.git
cd homelander
npm install
```

### Run (development)

```bash
# Terminal 1: Start the Vite dev server
npm run dev:renderer

# Terminal 2: Start Electron
npm run dev:electron
```

Or with a single command:

```bash
npm run dev
```

### Build (production)

```bash
npm run dist:mac     # macOS .dmg
npm run dist:win     # Windows .exe
npm run dist:linux   # Linux .deb + .AppImage
```

## First Launch

The setup wizard guides you through 5 steps:

1. **Your details** — name, email, phone, address
2. **Message template** — the message sent with each application
3. **IS24 account** — log in manually (IS24 blocks automated login)
4. **2captcha API key** — for automatic captcha solving
5. **First search** — paste an IS24 search URL

After setup, the app opens to the Searches tab. Add more searches anytime.

## Architecture

```
IS24 Mobile API ←─ HTTP ──→ [Poller → SQLite → Apply Engine → Chrome CDP] → IS24 Forms
                                   │                    │
                              Electron App         Headed, offscreen
                              (React UI)           (-32000,-32000px)
```

- **Poller**: Hits IS24's public mobile API every 10 minutes, discovers new listings
- **SQLite**: Stores filters, listings, results (at `~/.homelander/homelander.db`)
- **Apply Engine**: Reuses the battle-tested `is24-contactor.js` — fills forms, solves captchas, verifies submissions
- **Chrome**: Runs headed but offscreen — invisible to you, looks normal to IS24's anti-bot

## Configuration

All settings editable from the Settings tab:

- **Persona** — your contact details
- **Message template** — use `{{title}}`, `{{address}}`, `{{name}}` as placeholders
- **Timing** — speed preset (fast/balanced/slow), poll interval, send limits
- **2captcha API key** — stored encrypted in your OS keychain

Config is stored at `~/.homelander/config.json`.

## Data

All data is local — nothing is sent anywhere except:
- IS24's mobile API (to discover listings)
- IS24's website via Chrome (to submit contact forms)
- 2captcha API (to solve captchas)

Database at `~/.homelander/homelander.db`. Debug logs and screenshots at `~/.homelander/debug/`.

## Captcha Wall

IS24 triggers a captcha wall after ~12-15 contact form submissions. Homelander detects this and auto-pauses for 15 minutes. The polling continues — new listings accumulate and are processed after the cooldown.

You can also switch to **slow** mode (45-90s between listings) to avoid the wall entirely.

## Tips

- **Tauschwohnung listings** are immune to the captcha wall — add a Tausch search for reliable sends
- **Multiple searches** — add several URLs for different areas/budgets
- **Check history** — every application is logged with outcome and details
- **Pause per search** — pause individual searches while keeping others running

## License

MIT

## Credits

Built on the auto-apply engine developed and battle-tested across hundreds of IS24 listings.
