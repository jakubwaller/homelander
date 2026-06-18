# Homelander — IS24 Auto-Apply

Automates ImmobilienScout24 contact form submissions. Drives your real Chrome browser
via CDP — residential IP, real session, passes Datadome naturally.

## How it works

```
┌──────────┐  polls API    ┌──────────────┐  CDP (websocket)  ┌───────────┐
│  Fredy   │ ◄──────────── │  autoapply   │ ─────────────────►│  Chrome   │
│  :9998   │  new listings │  (Node.js)   │  navigate, fill,  │  (host)   │
└──────────┘               └──────────────┘  submit           │  :9222    │
                                                              └───────────┘
```

1. **Fredy** scrapes Immoscout24 and serves listings via REST API
2. **Autoapply** polls Fredy every 60s, diffs against seen state, fills and submits
   the IS24 contact form via Chrome CDP
3. Results logged to `autoapply/autoapply.log`

## Quick Start

```bash
git clone <repo-url> homelander
cd homelander
bash scripts/setup.sh        # one-time: check deps, create config
./scripts/homelander.sh      # daemon mode: polls forever until Ctrl+C
```

## Modes

| Command | Behavior |
|---------|----------|
| `./scripts/homelander.sh` | **Daemon mode.** Polls every 60s, processes listings, runs until killed. |
| `./scripts/homelander.sh --dry-run` | Daemon + dry-run: fills forms but never clicks submit. |
| `bash scripts/autoapply.sh` | **One-shot.** Processes pending listings and exits. Used by cron. |

The `scripts/homelander.sh` shell script auto-starts Chrome CDP if it's not already running.

## Configuration

All config lives in `config/autoapply.config.yaml` (gitignored, created by `setup.sh`).
See `config/autoapply.config.example.yaml` for the template.

| Key | Description |
|-----|-------------|
| `fredy.base_url` | Fredy API URL |
| `fredy.job_id` | Your IS24 search job ID in Fredy |
| `chrome.cdp_url` | Chrome CDP endpoint (default: `http://localhost:9222`) |
| `speed` | `"fast"`, `"balanced"` (default), or `"slow"` — controls typing delay, cooldowns |
| `polling.max_sends_per_run` | Safety cap per run (default: 15) |
| `captcha.api_key` | 2captcha API key (optional) |
| `contact.*` | Your details for the IS24 contact form |

Message template at `config/message.txt` — template text sent to landlords.

## Project structure

```
homelander/
├── scripts/
│   ├── setup.sh                 # one-command installer
│   ├── homelander.sh            # entry-point: daemon mode
│   └── autoapply.sh             # cron wrapper (one-shot)
├── src/
│   ├── launch.js                # config reader + spawner
│   ├── index.js                 # main loop: poll, dedup, send
│   ├── fredy-client.js          # Fredy REST API client
│   ├── is24-contactor.js        # IS24 form filler via Chrome CDP
│   ├── state-manager.js         # dedup + atomic state persistence
│   ├── captcha-solver.js        # 2captcha integration (optional)
│   └── config.js                # YAML config loader
├── config/
│   └── autoapply.config.example.yaml   # tracked
├── platform/macos/
│   └── com.homelander.chrome.plist     # launchd for Chrome auto-start
├── package.json
├── private/                     # gitignored (design docs, plans)
├── .gitignore
└── README.md
```

## Troubleshooting

**"Es ist ein Fehler aufgetreten"**
IS24 soft-block. Wait 24-48h, use a different profile, or slow down.

**Chrome CDP not reachable**
```bash
open -a "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug
```

**Captcha appears**
Add a 2captcha API key to config (`captcha.api_key`). Otherwise the listing is skipped
and retried next cycle.

## Future

- **Homelander.app** — cross-platform Electron app with setup wizard, dashboard,
  settings, and document manager. See `private/homelander-app-design.md`.
- **Premium listings** — IS24 Plus/premium listings are website-only and don't
  appear in the mobile API. Research in `private/premium-listings-plan.md`.

## License

MIT
