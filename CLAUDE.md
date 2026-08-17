# Homelander — Kaufradar

Analysis-only flat-purchase scanner. Polls IS24-buy / Kleinanzeigen / Neubaukompass searches,
enriches and geocodes the results, and serves them as a map ("Kaufradar") plus a weekly e-mail
report. **There is no apply path in this repository** — the Electron desktop app, the Puppeteer
apply engine and the React UI were removed; upstream still has them.

- **Repo:** `https://github.com/jakubwaller/homelander` (fork of `B1Z0N/homelander`)
- **License:** MIT — © Mykola Fedurko (upstream), © Jakub Waller (Kaufradar)

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node 22, ESM (`"type": "module"`), no framework |
| Database | better-sqlite3 12, WAL mode, single-file SQLite (schema v7) |
| UI | One hand-written HTML/CSS/JS page string + Leaflet from CDN |
| Geocoding | Nominatim (OSM), rate limited + cached in SQLite |
| Transit overlay | Overpass API, cached to the data dir, refreshed monthly |
| Mail | Dependency-free SMTP client |
| Deployment | Docker (`node:22-bookworm-slim`), single container |
| CI | GitHub Actions, ubuntu — unit tests + image build/boot |

`better-sqlite3` is the **only** dependency, runtime or dev.

## Architecture

One process, no IPC, no child processes:

```
engine/headless.js ── the entrypoint and the only long-lived loop
  │
  ├─ syncs searches from HOMELANDER_SCAN_URLS / scan-searches.json into SQLite
  ├─ every HOMELANDER_POLL_INTERVAL seconds:
  │    url-translator.js  → web search URL to mobile API params + fetchListings()
  │    sources.js         → IS24 buy / Kleinanzeigen / Neubaukompass + exposé enrichment
  │    scan-cycle.js      → post-processing shared by poll and startup:
  │                           media.js  (photos + Grundrisse into <data>/media/<hash>/)
  │                           geocoding (Nominatim, cached in geo_cache)
  │                           scan-listings.json export
  │                           report.js → smtp-mailer.js (weekly, if enabled)
  │
  └─ scan-server.js ── localhost HTTP server, serves:
       scan-page.js  → the whole single-page UI as one string
       uploads.js    → per-property document store
       transit.js    → U-/S-Bahn geometry for the map overlay
```

## Source Tree

```
homelander/
├── engine/
│   ├── headless.js       # Entrypoint: search sync, poll loop, server start
│   ├── db.js             # HomelanderDB — SQLite via better-sqlite3 (schema v7)
│   ├── url-translator.js # IS24 web URL → mobile API params + fetchListings()
│   ├── sources.js        # Multi-source scan + exposé enrichment + Nominatim geocoding
│   ├── scan-cycle.js     # Shared scan post-processing (enrich + export + report)
│   ├── scan-server.js    # Kaufradar HTTP server (API + page + uploads)
│   ├── scan-page.js      # Kaufradar single-page UI (inline HTML/CSS/JS + Leaflet)
│   ├── media.js          # Photo + Grundriss archive per listing
│   ├── transit.js        # Overpass U-/S-Bahn route geometry, monthly refresh
│   ├── uploads.js        # Per-property document store (<data>/uploads/<hash>/ + files.json)
│   ├── report.js         # Weekly scan report (HTML builder + due-date logic)
│   └── smtp-mailer.js    # Dependency-free SMTP client (SSL/STARTTLS/AUTH)
├── scripts/
│   └── test-param-coverage.js   # Live IS24 mobile-API param canary (monthly workflow)
├── test/                 # Node test runner: 10 suites + smoke-db.mjs
├── .github/workflows/
│   ├── ci.yml            # PR + push to main: tests, then image build + boot check
│   └── param-coverage.yml # Monthly: live IS24 param drift canary
├── Dockerfile            # Two-stage; copies engine/ + package.json only
├── docker-compose.yml
└── .env.example          # The only configuration surface
```

## Configuration

Environment variables only — there is no config UI and no persona. See `.env.example`.
`HOMELANDER_DATA_DIR` (default `~/.homelander`, `/data` in the container) holds:

- `homelander.db` — SQLite, WAL (`filters`, `listings`, `results`, `manual_skips`, `geo_cache`,
  `scan_seen`, `scan_favorite`)
- `scan-listings.json` — rewritten after every poll
- `media/<hash>/` — archived photos and floor plans + `media.json`
- `uploads/<hash>/` — user-supplied documents + `files.json` manifest
- `transit-lines.json`, `.last-scan-report`

`scan-searches.json` and `manual-projects.json` are read from the data dir (and the repo dir when
running outside Docker); both are gitignored — never commit them.

## Key Invariants

- **Analysis-only, structurally** — there is no contactor, no Puppeteer, no Chromium. Do not
  reintroduce an apply path; that is upstream's repo, not this one.
- **Buy searches must NOT send `pricetype`** — the IS24 mobile API rejects it with 412 for
  apartmentbuy/housebuy/plotbuy
- **Kaufradar binds to 127.0.0.1 by default** (port 8477); the container overrides the host to
  0.0.0.0 because Docker port-mapping needs it. It has no authentication — anything public needs a
  reverse proxy in front.
- **Nominatim geocoding is rate-limited to 1 req/s** and cached in the `geo_cache` table — never
  bypass the cache
- **`scan_seen` / `scan_favorite` share one hash space** — a 16-hex listing hash or the 64-hex
  `sha256('project|<name>')` of a manual Neubau pin; the same holds for `uploads/<hash>/`, so no
  foreign key to `listings` exists or should be added
- **A listing hash is `sha256(expose_id|price)`** — a price change mints a new listing, which
  resurfaces it as unseen and orphans its uploads. Deliberate for the seen flag; a known wart for
  uploads.
- **Uploaded files are served from the manifest only** — `files.json` membership is the
  authorisation check; never resolve a request path straight onto disk, and never serve an unknown
  type inline (HTML/SVG would run on the Kaufradar's origin)
- **`npm ci` must be paired with an explicit `npm rebuild better-sqlite3`** — newer npm gates
  install scripts behind an approval prompt, so the native build cannot be left implicit (both the
  Dockerfile and CI do this)
- **Overpass 406s a bare node-fetch User-Agent** — `transit.js` sends a real one

## Deployment

Runs as a single container on a VPS. Deploy = merge to `main`, then on the host:

```bash
cd ~/homelander && git pull && docker compose up -d --build
```

`main` is protected by a ruleset: no direct pushes, PR required, linear history, no bypass actors.
Branch, open a PR, let CI go green, squash-merge.

## Development

```bash
npm install --ignore-scripts && npm rebuild better-sqlite3
npm run scanner      # run the scanner directly, no Docker
npm test             # unit tests (283)
npm run smoke:db     # DB smoke test
docker compose up -d --build
```
