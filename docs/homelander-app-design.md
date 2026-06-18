# Homelander.app — Design Document

> Status: Design phase. Not implemented. Use this as the blueprint when building.

---

## Overview

**Homelander** is a cross-platform desktop application that automates the Immobilienscout24
contact process. The user opens the app, fills in a one-time setup wizard, and it runs in
the background — finding listings, filling out contact forms, and tracking results.

Target users: non-technical apartment hunters in Germany. Zero terminal. Zero Docker.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  Electron App                     │
│                                                   │
│  ┌──────────────┐       ┌───────────────────────┐ │
│  │  Main Process │       │  Renderer (React SPA) │ │
│  │               │ IPC   │                       │ │
│  │  - lifecycle  │◄─────►│  SetupWizard          │ │
│  │  - config r/w │       │  Dashboard            │ │
│  │  - daemon mgr │       │  Settings             │ │
│  │  - updater    │       │  Logs                 │ │
│  └──────┬────────┘       └───────────────────────┘ │
│         │ spawn                                     │
│  ┌──────▼────────┐                                  │
│  │  autoapply/    │  child_process.fork()           │
│  │  launch.js     │  (same Node, separate heap)     │
│  │  --electron    │                                  │
│  │  --watch       │                                  │
│  └──────┬────────┘                                  │
│         │ puppeteer (bundled Chromium)               │
│  ┌──────▼────────┐                                  │
│  │  Chromium      │  headed, offscreen (-32000px)   │
│  │  :9222         │  invisible to user              │
│  └───────────────┘                                  │
└──────────────────────────────────────────────────┘
```

## Technology decisions

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Desktop shell | **Electron** | Same JS runtime as auto-apply. No IPC between Rust/Node. Mature packaging. |
| UI | **React 19 + Tailwind** | Modern, fast iteration |
| Build | **Vite (electron-vite)** | Fast HMR in dev |
| State | **Zustand** | Lightweight, simpler than Redux |
| IPC | **contextBridge + ipcRenderer** | Secure typed bridge |
| Packaging | **electron-builder** | .dmg / .exe / .deb / AppImage |
| Updates | **electron-updater** | GitHub Releases auto-update |
| Config store | **electron-store** | Encrypted JSON at OS-specific paths |
| Chromium | **Bundled, headed, offscreen** | No "install Chrome" step. Headed = Datadome-safe. Offscreen at `--window-position=-32000,-32000` = invisible to user |

## Why not Tauri / Flutter

**Tauri:** Auto-apply is Node.js (Puppeteer). Tauri is Rust. Would need a sidecar Node process
or a full rewrite in Rust + headless_chrome. Two languages, messy IPC. Wrong trade.

**Flutter Desktop:** Third language (Dart). Auto-apply as external process. Unnecessary complexity.

**Electron:** Single language. Auto-apply lives in the same runtime. The "heavy" argument is moot —
we already ship Chromium for CDP.

## Why headed + offscreen, not headless

Datadome detects true headless mode through structural differences
(`chrome.runtime` is `undefined`, WebGL is Swiftshader, no window chrome metrics).
New headless mode (Chrome 112+) hides some tells but not all.

**Solution:** Launch Chromium headed but at `--window-position=-32000,-32000` — 32,000 pixels
offscreen. The window exists, all APIs work, Datadome sees a normal browser.
The user sees nothing. This is what commercial bots use.

v2 can add an experimental "true headless" toggle for power users.

## Fredy relationship

Fredy (the scraper backend) is **separate**. Homelander is a client.

- User hosts Fredy on a VPS (or uses a hosted instance)
- Wizard asks for Fredy URL + auth → [Test connection] button hits `GET /api/health`
- HomeLander polls `GET /api/autoapply/next` for listings
- Fredy is not bundled; Homelander has zero opinion about how you run Fredy

This separation means:
- No bundling complexity
- No "your Fredy version is too old" support issues
- Clean business model: sell hosted Fredy access + Homelander as a package

## Screens (v1 scope)

### 1. Setup Wizard (first launch only)

4-step guided flow with progress indicator. No terminal.

**Step 1 — Your details**
- Salutation (Herr / Frau / Divers)
- First name, last name
- Email, phone number

**Step 2 — Your story**
- Job title
- Income (net, monthly)
- Family situation (single / couple / family)
- Pets? Smoker?
- Move-in timeframe
- Message template — live preview that updates as you fill fields:

```
┌─────────────────────────────────────────┐
│                                          │
│  I am a [software engineer] working at   │
│  [Acme Corp] with a net income of        │
│  [4.200€]. I live [alone] and have       │
│  [no pets]. I am looking to move in      │
│  [as soon as possible].                  │
│                                          │
│  ──────────────────────────────────────  │
│  Live preview:                           │
│                                          │
│  Sehr geehrte Damen und Herren,          │
│                                          │
│  ich bin Software Engineer bei Acme      │
│  Corp mit einem Nettoeinkommen von       │
│  4.200€...                               │
└─────────────────────────────────────────┘
```

**Step 3 — Connection**
- Fredy server URL
- Fredy auth credentials
- [Test connection] button → green check or error message
- IS24 credentials (email + password)
- Note: stored encrypted via electron-store. v2: OS keychain integration.

**Step 4 — Preferences**
- Speed: careful / normal / fast
- Max sends per day
- Document attachments: toggle + folder picker (Schufa, Gehaltsnachweise, etc.)

"Start searching" button at the bottom saves config and launches the daemon.

### 2. Dashboard (returning user)

```
┌─────────────────────────────────────────────────┐
│  🏠 Homelander                    ⚙️  🔔  ─ ✕  │
├─────────────────────────────────────────────────┤
│                                                  │
│   ● Active — searching every 60s                │
│                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │   142    │ │    23    │ │    8     │        │
│  │  seen    │ │  sent    │ │  today   │        │
│  └──────────┘ └──────────┘ └──────────┘        │
│                                                  │
│  Recent activity                                 │
│  ┌──────────────────────────────────────────┐   │
│  │ 14:32  ✓  3-Zi. Whg., Berlin-Mitte       │   │
│  │ 14:31  ✓  2-Zi. Whg., Kreuzberg          │   │
│  │ 14:30  ✗  1-Zi. Whg., Neukölln (captcha) │   │
│  │ 14:29  ✓  4-Zi. Whg., Friedrichshain     │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  [⏸ Pause]  [⚙ Settings]  [📋 View log]        │
│                                                  │
└─────────────────────────────────────────────────┘
```

- Green status dot + status text when daemon running
- Stats cards (seen / sent total / sent today)
- Live-scrolling activity feed with success/failure icons
- Pause / resume button
- Native OS notifications on each send (optional)

Window close = hide to background (daemon keeps running). Explicit quit via Settings.

### 3. Settings

- Speed toggle: careful / normal / fast
- Daily send cap
- Message template editor (full text, not just the wizard fill-ins)
- Personal details edit
- IS24 credentials edit
- Fredy server URL + auth edit
- Document attachments manager
- [Quit Homelander] button — stops daemon, closes app

### 4. Document Manager

- List of attached documents
- Add / remove / preview
- Types: Schufa, Gehaltsnachweise, Mieterselbstauskunft, custom
- Sent count per document (how many applications included this doc)

### 5. Logs

- Filterable by: date, status (sent / failed / captcha / skipped)
- Search by listing title or address
- Export to CSV
- "Sent" and "Failed" tabs

## How the daemon communicates

The existing `autoapply/` code stays almost unchanged. One new flag:

```
launch.js --electron --watch
```

- `--electron`: reads config from electron-store path (JSON), not YAML
- `--watch`: daemon mode (already implemented)

Status updates go to stdout as JSON lines:

```json
{"type":"seen","listing":{"id":"123","title":"3-Zi. Whg.","address":"Berlin-Mitte","price":1200}}
{"type":"sent","listing":{"id":"123","title":"3-Zi. Whg.","address":"Berlin-Mitte","price":1200},"time":"14:32:01"}
{"type":"failed","listing":{"id":"456","title":"1-Zi. Whg.","address":"Neukölln","price":800},"reason":"captcha","time":"14:30:45"}
{"type":"stats","seen":142,"sent":23,"today":8}
```

Electron's `daemon.ts` parses these lines via split2 stream, emits IPC events to the renderer.
The renderer updates Zustand store in real time.

## Project structure

```
homelander-app/
├── electron/
│   ├── main.ts              # App lifecycle, BrowserWindow, menu
│   ├── preload.ts           # Bridge: main ↔ renderer (contextBridge)
│   ├── daemon.ts            # Spawn/monitor/kill auto-apply child process
│   ├── config.ts            # Read/write electron-store
│   └── updater.ts           # electron-updater logic
├── src/                     # React renderer (Vite)
│   ├── App.tsx
│   ├── main.tsx
│   ├── screens/
│   │   ├── SetupWizard.tsx       # First-launch wizard
│   │   ├── SetupStepPersonal.tsx # Step 1
│   │   ├── SetupStepStory.tsx    # Step 2 (with live preview)
│   │   ├── SetupStepConnection.tsx # Step 3
│   │   ├── SetupStepPreferences.tsx # Step 4
│   │   ├── Dashboard.tsx
│   │   ├── Settings.tsx
│   │   ├── DocumentManager.tsx
│   │   └── Logs.tsx
│   ├── components/
│   │   ├── StatCard.tsx
│   │   ├── ActivityFeed.tsx
│   │   ├── StatusDot.tsx
│   │   ├── StepIndicator.tsx
│   │   └── LivePreview.tsx
│   ├── stores/
│   │   └── appStore.ts      # Zustand: config, daemon status, stats, activity
│   └── styles/
│       └── index.css        # Tailwind
├── autoapply/               # Existing auto-apply code (submodule or symlink)
│   ├── src/
│   │   ├── launch.js
│   │   ├── index.js
│   │   ├── is24-contactor.js
│   │   ├── fredy-client.js
│   │   └── state-manager.js
│   └── config/              # Generated by electron-store, not hand-edited
├── resources/               # App icons (all platforms), tray assets
│   ├── icon.icns
│   ├── icon.ico
│   └── icon.png
├── package.json
├── electron-builder.yml     # Build config for all platforms
├── tailwind.config.ts
└── vite.config.ts
```

## Distribution

`electron-builder` produces:

| Platform | Format | Notes |
|----------|--------|-------|
| macOS | `.dmg` with background image | Requires Apple Developer account for signing |
| Windows | `.exe` NSIS installer | |
| Linux | `.deb` + `.AppImage` | |

Auto-updates via `electron-updater` pulling from GitHub Releases.
Users never think about versions.

## Sensitive data

**IS24 credentials (email + password):** stored in electron-store with AES encryption.
v1: this is sufficient. In-memory for the daemon (unavoidable — Puppeteer needs to type the password).
v2: OS keychain (macOS Keychain, Windows Credential Manager, libsecret on Linux).

**Fredy auth token:** same treatment.

## Window behavior

- Close button = hide to background (daemon keeps running). Same model as Slack / Discord.
- Reopening the window reconnects to the main process via IPC. Dashboard shows current stats immediately (no stale snapshot).
- System tray: NOT in v1. Just a window. Cross-platform consistency.
- To quit: Settings → Quit Homelander. This stops the daemon gracefully, closes Chromium, then exits.

## Premium listings

IS24 premium/Plus listings are excluded because Fredy uses the mobile API, which doesn't
surface them. This is IS24-specific — all other platforms scrape HTML and include everything.

Three approaches researched (see `docs/premium-listings-plan.md`):
1. Authenticated mobile API — try first (lowest effort)
2. Chrome-based premium scraper — fallback (~100 lines)
3. Email scraper — safety net

Not implemented in v1. Tracked in `docs/premium-listings-plan.md`.
