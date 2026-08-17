<p align="center">
  <img src="brand/social/avatar-1024.png" width="128" alt="Homelander">
</p>

<h1 align="center">Homelander — Kaufradar</h1>

<p align="center">
  <b>Analysis-only flat-purchase scanner</b><br>
  Watches IS24 and Kleinanzeigen buy listings, puts them on a map and mails a weekly report.
  It never applies to anything.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License">
  <img src="https://img.shields.io/badge/platform-Docker-2496ed" alt="Docker">
  <img src="https://img.shields.io/badge/node-22-5fa04e" alt="Node 22">
</p>

## 🔭 About this fork

Upstream [B1Z0N/homelander](https://github.com/B1Z0N/homelander) is an Electron desktop app that
auto-applies to IS24 **rental** listings. This fork keeps only **Kaufradar**, its scan-only half
for *buying*: it collects IS24-buy and Kleinanzeigen listings, enriches and geocodes them, and
serves a Leaflet map with photos, floor plans, a seen-flag, favourites, per-property file uploads,
a U-/S-Bahn overlay and a weekly e-mail report.

The desktop app, the apply engine, the Chromium automation and the React UI have all been
**removed from this repository** — not disabled, removed. There is no code here that can submit
anything to a portal. For the desktop app, go upstream; its
[Releases](https://github.com/B1Z0N/homelander/releases) are the only place binaries come from.

## 🗺️ Run it

```bash
cp .env.example .env           # searches + optional SMTP settings
docker compose up -d --build
# Kaufradar: http://<host-address>:8477
```

Works on Raspberry Pi / ARM: the base image (`node:22-bookworm-slim`) is published for `arm64` and
`arm/v7`, and the only native module (`better-sqlite3`) uses a prebuilt binary when available and
otherwise compiles during the build — expect the first `docker compose up -d --build` on a Pi to
take a few minutes.

⚠️ The Kaufradar has **no authentication** — the provided compose file exposes it to your LAN. Only
do that on a private network you trust; on shared networks bind it to `127.0.0.1:8477:8477` and
put a reverse proxy with auth in front.

## ⚙️ Configuration

Everything is environment variables in `.env` (see `.env.example`); there is no config UI.

| Variable | Purpose |
|---|---|
| `HOMELANDER_SCAN_URLS` | Comma- or newline-separated IS24-buy / Kleinanzeigen / Neubaukompass search URLs |
| `HOMELANDER_POLL_INTERVAL` | Seconds between polls (default 600) |
| `HOMELANDER_DATA_DIR` | Where the DB, exports, media and uploads live (`/data` in the container) |
| `HOMELANDER_SCAN_HOST` / `_PORT` | Bind address and port for the Kaufradar site |
| `HOMELANDER_REPORT_ENABLED`, `_TO`, `HOMELANDER_SMTP_*` | Weekly e-mail report |

Searches can also come from a `scan-searches.json` in the data volume (an array of URL strings or
`{ "url", "name" }` objects), which is what you want once the list outgrows an env var.

The map overlays local U-/S-Bahn lines (route geometry fetched from Overpass into the data volume,
refreshed monthly) and renders gold pins from an optional `manual-projects.json` — a JSON array of
`{ "name", "url", "address", "lat", "lng", "note" }` objects for Neubau projects that are marketed
only on a developer's own site and never reach the portals.

Every entry — portal listing or Neubau pin — can be **starred** (★ button; "★ Nur Favoriten"
filters the list and the map) and takes **file uploads**: drop the price lists, exposés and
Grundriss PDFs a developer mails you onto the detail view and they stay with the property, in
`<data dir>/uploads/<hash>/`.

For the weekly report with ProtonMail use `smtp.protonmail.ch:587` and a dedicated SMTP token
(paid plan, paired with a custom-domain address; the From address must equal the token's address —
it defaults to `HOMELANDER_SMTP_USER`).

## 📦 How it works

```
IS24 mobile API ─┐
Kleinanzeigen ───┼─→ poll → SQLite → enrich (exposé, photos, Grundrisse)
Neubaukompass ───┘                 → geocode (Nominatim, cached)
                                   → scan-listings.json + Kaufradar map
                                   → weekly e-mail report
```

One process, `engine/headless.js`. It polls each search on an interval, writes new listings to
SQLite, fetches each exposé for details and media, geocodes addresses through Nominatim (rate
limited to 1 req/s and cached in the DB), and serves the whole thing as a single-page map site.

## 📊 Data & privacy

All data is local. The scanner talks to: the portals' own APIs and listing pages, Overpass and
Nominatim (OpenStreetMap) for transit geometry and geocoding, and your SMTP server if the weekly
report is on. No telemetry, no analytics, no cloud.

## 🛠️ Development

```bash
npm install          # better-sqlite3 is the only runtime dependency
npm run scanner      # run it directly, without Docker
npm test             # unit tests
npm run smoke:db     # DB smoke test
```

## ⚠️ Disclaimer

Kaufradar is a **hobby project**. It is **analysis-only**: it reads publicly reachable listing
pages for personal use and submits nothing — there is no apply engine in this repository at all.

This project is **not affiliated with, endorsed by, or connected to** ImmobilienScout24 GmbH,
Kleinanzeigen GmbH & Co. KG, or any other listing portal. Automated access may violate a portal's
terms of service — check them yourself before pointing this at anything. The authors assume no
liability for any consequences, including but not limited to account restrictions, blocked access,
legal claims, or any other actions taken by a portal operator or any other party. This software is
provided "as is" without warranty of any kind.

## 🤝 Contributing

Issues and discussions are disabled on this fork. For the desktop app, report bugs and feature
ideas [upstream](https://github.com/B1Z0N/homelander/issues).

## ❤️ Support

If the Kaufradar helped you, you can buy me a coffee: <https://ko-fi.com/jakubwaller>

The desktop app this forked from is [B1Z0N](https://github.com/B1Z0N)'s work — support him on
[GitHub Sponsors](https://github.com/sponsors/B1Z0N),
[Buy Me a Coffee](https://www.buymeacoffee.com/b1z0n) or [Ko-fi](https://ko-fi.com/b1z0n).

## 📄 License

MIT. Original project © [Mykola Fedurko](https://github.com/B1Z0N), Kaufradar fork additions ©
[Jakub Waller](https://github.com/jakubwaller). See [LICENSE](LICENSE).

## 🙏 Credits

Built on the poller, database layer and IS24 URL translation from the upstream project. Key icon
brand by the original author.
