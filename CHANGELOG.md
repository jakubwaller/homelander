# Changelog

All notable changes to Homelander are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Flat-purchase scanning (analysis-only)**: IS24 buy searches (`wohnung-kaufen`, `haus-kaufen`, `grundstueck-kaufen`) are now supported and automatically run in a new per-search `scan` mode — listings are collected and enriched but **never** auto-applied to
- **Kaufradar**: local browse website (`http://127.0.0.1:8477`, bound to localhost) with listing grid, text/price/rooms/size filters, sorting, detail view (exposé attributes, descriptions) and an OpenStreetMap/Leaflet map of all scanned offers; "Kaufradar öffnen" button on the Searches tab
- **Additional sources**: paste Kleinanzeigen search URLs (`kleinanzeigen.de/s-…`) or Neubaukompass project searches (`neubaukompass.de/neubau-immobilien/…`, for Neubau projects) into Add Search — both are scan-only sources
- **Listing enrichment**: scanned IS24 listings get exposé details (costs, condition, energy, description texts) and map coordinates (exact location or postcode-area centroid); other sources are geocoded by postcode via Nominatim (cached in SQLite `geo_cache`)
- **Favourites**: star any Kaufradar entry — portal listing or manual Neubau pin — with the ★ button on the card, in the detail view or in a map popup; "★ Nur Favoriten" filters list *and* map down to them, starred entries survive "Gesehene ausblenden" and keep their colour on the map (gold ring, larger dot). DB schema v7: `scan_favorite` table, `POST /api/scan/favorite`
- **File uploads per property**: drop PDFs (price lists, exposés, Grundrisse) or any other document onto a listing or Neubau project in the Kaufradar detail view — stored in `<data dir>/uploads/<hash>/` with a `files.json` manifest, listed with size and date, downloadable and deletable; cards show a 📎 badge. Endpoints `GET/POST /api/scan/files/<hash>`, `DELETE /api/scan/files/<hash>/<file>`, `GET /files/<hash>/<file>` (25 MB per file; only PDFs, images and plain text are served inline, everything else downloads)
- **Local JSON export**: all scanned listings are written to `~/.homelander/scan-listings.json` after every poll
- **Weekly e-mail report**: optional weekly summary of scanned flats via user-configured SMTP (Settings → Wochenbericht). Dependency-free SMTP client with SSL/STARTTLS/AUTH — works with Proton Mail Bridge (127.0.0.1:1025) and Proton Business SMTP tokens
- DB schema v5: `filters.mode`/`filters.source`, listing `url`/`source`/`postcode`/`lat`/`lng`/`scan_json` columns, `geo_cache` table; existing buy filters migrate to scan mode
- **Docker deployment (headless scanner)**: `Dockerfile` + `docker-compose.yml` run the analysis-only half (poll, enrich, export, Kaufradar, weekly report) via `engine/headless.js` — no Electron/Chromium, can never apply. Searches via `HOMELANDER_SCAN_URLS` env or `scan-searches.json` in the `/data` volume; `npm run scanner` runs the same entrypoint locally
- **Env-configured report SMTP for Docker**: `HOMELANDER_SMTP_HOST/PORT/USER/PASSWORD` from `.env` (`env_file` in compose, `.env.example` committed, `.env` gitignored) — ProtonMail SMTP-token pattern (`smtp.protonmail.ch:587` STARTTLS, From = token address); the desktop app keeps its Settings-based SMTP config. Compose exposes the Kaufradar to the LAN by default (no auth — private networks only)

- Screenshots section in README (Search, History, Settings)
- Installation section in README with platform table, macOS `xattr -cr`, Windows SmartScreen note
- Donation support: `.github/FUNDING.yml` (GitHub Sponsors, Buy Me a Coffee, Ko-fi)
- Donation section in README with styled badge buttons
- Donation card in Settings tab (between Language and Clean All Data)

### Changed
- README restructured: Screenshots → Why → Features → Installation → Disclaimer → …
- Disclaimer strengthened: hobby/portfolio project, not for actual IS24 use, strictly prohibited
- `{{name}}` now resolves to `Vorname Nachname` only (no Herr/Frau / Anrede)

### Removed
- Captcha wall auto-pause: removed `consecutiveCaptchas` counter, 5-failure pause, auto-resume, `captcha_wall` IPC emission

### Fixed
- IS24 buy searches no longer send the `pricetype` parameter, which the mobile API rejects with HTTP 412 (buy searches always errored before)
- Buy listing prices/sizes/rooms are parsed from the mobile API's label-less German-formatted attributes ("899.000 €" / "165 m²" / "5,5 Zi.")
- Daemon no longer requires a running Chromium when only scan-mode searches are enabled (apply loop idles instead of killing the daemon, polling continues)
- `{{name}}` template resolution now consistent between Settings preview, Setup wizard preview, and actual daemon messages

## [1.3.3] - 2026-06-25

### Added
- `--disable-gpu` flag on macOS to prevent SwiftShader GPU compositor zombie on screen lock

### Changed
- Removed UA spoofing — use natural Chrome for Testing identity
- GPU compositing flags scoped to Windows-only

### Fixed
- Clicking X now quits the app instead of hiding to background
- Perimeter captcha: don't use `return` in `finally` block (overrode captcha result)
- Perimeter captcha: stay on captcha page, don't redirect to IS24
- Perimeter captcha: don't navigate to `about:blank`

## [1.3.2] - 2026-06-20

### Fixed
- Detach daemon from parent Job Object + elevate OS priority to prevent Windows background throttling
- Disable Windows EcoQoS power throttling + force 1ms timer resolution via Win32 API
- Add CalculateNativeWinOcclusion flag for Windows virtual-desktop resilience

## [1.3.1] - 2026-06-15

### Fixed
- Clean all data now deletes logs, Chrome profiles, and support bundles
- Also delete `debug/` directory on clean all data
- Re-verify move-in date at end of form fill
- Prevent empty history list on double-clicking same outcome filter

## [1.3.0] - 2026-06-10

### Added
- Echo daemon events to stderr for CLI dev visibility
- CDP HTTP ping before each apply round and listing
- SVG flags for language picker
- AWS WAF perimeter captcha detection, pause + notify in status bar

### Changed
- Notifications: removed SENT/FAIL/captcha_wall, added perimeter_captcha
- Chrome bundled into installer (no runtime download)

### Fixed
- Prevent macOS Space-switch CDP timeouts (App Nap + stdout backpressure)
- Close shared DB handle before unlinking in `data:clean`
- SVG flags — proper 3:2 aspect ratio, Union Jack clip-path
- Fix EBUSY on data clean (await daemon exit + db.close)
- CI: auto-bump package.json version from release tag input

## [1.2.2] - 2026-06-01

### Added
- SVG icons, uniform badges

### Fixed
- Windows virtual-desktop anti-deadlock flags

## [1.2.1] - 2026-05-28

### Fixed
- Parentheses around `??`/`||` in JSX to fix build
- Scope per-filter 'Processed X/Y' denominator to today

## [1.2.0] - 2026-05-25

### Added
- Bundle Chromium in installer — remove runtime download step

## [1.1.x] - 2026-05 (series)

### Added
- Chromium download progress wired to setup wizard (1.1.22)
- Directory walk for Chrome executable — finds chrome.exe wherever it extracts (1.1.21)
- Chrome startup diagnostics — log executable path, PID, file existence (1.1.18)
- Homelander key icon in setup wizard header

### Fixed
- Route `ensureChromiumInstalled` logs to chrome.log (1.1.20)
- `_logToFile` require() broken in ESM — logs never written (1.1.19)
- `--enable-logging --log-file` for Chromium spawn on Windows (1.1.17)
- Include Chrome crash info + chrome.log in support bundle
- 🐞 tooltip now anchored to right edge — no longer overflows screen
