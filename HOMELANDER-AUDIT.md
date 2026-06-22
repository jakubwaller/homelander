# Homelander Codebase Audit

_v1.1.4 · audited 2026-06-22 · Electron 34 / React 19 / Node 22 / better-sqlite3 11 / Puppeteer 24_

All findings cite files actually read. Line numbers approximate the relevant block.

---

## Executive Summary

**Health score: 6.5 / 10** — solid product engineering, weak operational hygiene.

- **Solid:** thoughtful IS24 edge-case handling (session-expiry, premium gate, deactivated, captcha wall); clean i18n parity (de 338 / en 338 keys); good user-facing error mapping (`userErrors.js`); 158 unit tests on pure logic; zero TODO/FIXME debt; single-instance lock + hot-reload config.
- **Fragile:** ~64 silent error swallowers; secrets + applicant PII leak through support bundles; DB connection opened/closed (and leaked on error) per IPC call; no tests for the daemon, IPC, Chrome, or any React code; Electron 34 carries 1 high-severity advisory.
- **Top 3 risks (by blast radius):**
  1. **Privacy/secret exposure** — plaintext 2captcha key in config + un-redacted applicant PII in per-entry debug bundles the UI tells users to email out.
  2. **Silent failure surface** — ~64 swallowed errors and no daemon/IPC/UI tests mean field bugs are effectively invisible.
  3. **Poll-loop fragility** — `fetchListings()` has no fetch timeout; one unresponsive IS24 socket stalls all polling (~5 min) while the UI still shows "Active".
- **Bottom line:** A capable, well-thought-out app whose biggest exposures are privacy/observability, not core logic — fixable without architectural upheaval.
- **Totals: 2 critical, 8 high, 7 medium, ~6 low.**

---

## Critical Issues

**Bug:** Per-entry "Export Debug Bundle" raw-copies multi-MB IS24 HTML snapshots that embed the filled contact form (applicant name, email, phone, address, message), and the UI instructs users to email the bundle to the developer.
**electron/main.js:~290** (entry-scope `cpSync` loop) + **engine/is24-contactor.js:~301** (`await this.page.content()` dump) + **src/screens/HistoryTab.jsx:~498** / **SettingsTab.jsx:~196**.
**Impact:** Verified — `debug/html/*_SENT.html` files are ~4.3 MB and contain submitted email addresses and `contactName`; the entry bundle copies them verbatim (no redaction, unlike `config.redacted.json` and logs). Sharing a bundle leaks the user's real persona to a third party.
**Fix:** Before bundling, run HTML snapshots through a value-stripping pass (clear `<input value>`, `<textarea>` contents, and email/phone regex) — or exclude raw HTML from shareable bundles and ship a DOM-structure-only summary. Reuse `redactSupportText()` but gate it on size, or strip form fields in `is24-contactor.js` before writing the dump. Update the "email this to the developer" copy to warn it still contains listing data.

**Bug:** The 2captcha API key (and the `is24.password` field, if set) is stored in cleartext in `~/.homelander/config.json`, while the README claims it is "stored encrypted on your machine."
**electron/main.js:84** (`saveConfig` → `JSON.stringify(config)`) + **README.md** ("2captcha API key — stored encrypted").
**Impact:** Verified — `saveConfig()` performs a plain `writeFileSync(JSON.stringify(...))`; no encryption exists anywhere. Any local process, backup/cloud-sync, or mistaken file share exposes the key. The documentation actively misleads users about protection they don't have.
**Fix:** Encrypt secrets with Electron's built-in `safeStorage` (`safeStorage.encryptString`/`decryptString`, OS-keychain backed) before writing, and decrypt on load; keep non-secret config in JSON. If encryption is deferred, correct the README to say secrets are stored in plaintext. Do not collect `is24.password` at all if login is manual-only.

---

## High-Impact Issues

**Bug:** `fetchListings()` / `getTotalResults()` issue `fetch()` with no `AbortSignal` timeout.
**engine/url-translator.js:609, 586.**
**Impact:** A hung IS24 socket blocks the awaited call (~300 s undici default) per page, sequentially across pages and filters, stalling all polling while the countdown freezes and status shows "Active". Eventually surfaces as `poll_error` after minutes of missed listings — the app's core value.
**Fix:** Add `signal: AbortSignal.timeout(15000)` to both, matching the pattern already used in `captcha:validate` (main.js).

**Bug:** `setConfigAppliedFlash` is called but never declared.
**src/screens/SearchTab.jsx:253-254.**
**Impact:** Verified — grep finds only the two call sites, no `useState`. When the `homelander:config-applied` event fires while the Searches tab is mounted, the handler throws `ReferenceError`; the "config applied" flash is permanently broken.
**Fix:** Add `const [configAppliedFlash, setConfigAppliedFlash] = useState(false)` and render it, or delete the dead handler.

**Bug:** ~64 silent error swallowers (47 bare `catch {}` + 17 `.catch(() => {})`).
**electron/, engine/, src/ (pervasive).**
**Impact:** Failures in CDP ops, DB writes, navigation, screenshots, and IPC are discarded with no trace, making field diagnosis (the whole point of the support-bundle feature) nearly impossible and masking real regressions.
**Fix:** Route catches through a single `logDebug(err, context)` helper that appends to `daemon.log`; reserve true no-ops for genuinely ignorable cases and comment why.

**Bug:** A fresh `new HomelanderDB(DB_PATH)` is opened (running `_migrate`) and closed on nearly every IPC call, and is leaked on the error path (no `try/finally`).
**electron/main.js:895+ (`filters:list`, `listings:history`, `listings:stats`, …).**
**Impact:** If a query throws, `db.close()` is skipped and the SQLite handle leaks; connection churn also competes with the daemon's long-lived WAL connection on a 30 s + event-driven refresh cadence.
**Fix:** Use one lazily-created shared read connection in main, or wrap each handler in `try { … } finally { db.close(); }`.

**Bug:** The 15-minute captcha-wall pause is in-memory only; unlike manual pause it never writes the pause flag.
**engine/daemon.js:~470 (`consecutiveCaptchas >= 5` block).**
**Impact:** If the daemon auto-restarts during the cooldown (crash/Chrome death), it resumes applying immediately and re-hits the wall, defeating the backoff.
**Fix:** `writePauseFlag('captcha_wall')` with the resume timestamp and restore `pauseResumeTime` on startup.

**Bug:** Listings with empty `expose_id` are inserted from ad/sponsored API rows.
**engine/url-translator.js:~640 (`expose_id: String(expose.id || expose.exposeId || '')`).**
**Impact:** Junk history rows and wasted apply attempts against `/expose/#/basicContact/email`; multiple empty-id rows also collide on the `expose_id|price` hash.
**Fix:** `filter(l => l.expose_id)` before returning listings.

**Bug:** "Today" is computed in UTC in `getStats()` but in localtime in `getTodayStats()`.
**engine/db.js:~232 vs ~265 (`date('now')` vs `date('now','localtime')`).**
**Impact:** History (all-time) and Searches (today) disagree on day boundaries near midnight; counts flicker depending on timezone offset.
**Fix:** Standardize on `date('now','localtime')` everywhere.

**Bug:** Debug artifacts grow unbounded — every apply writes a ~4 MB HTML dump + full-page screenshots with no rotation.
**engine/is24-contactor.js (screenshot/HTML writes throughout `apply`).**
**Impact:** Hundreds of applies → multiple GB in `~/.homelander/debug/`; synchronous `writeFileSync` of 4 MB also briefly blocks the daemon per apply.
**Fix:** Cap by count/age and prune oldest on startup; gate full-page HTML dumps behind a debug flag.

---

## Dead Code

| File | Symbol | Why |
|------|--------|-----|
| package.json | `electron-store` dep | Never imported; config uses raw `fs` JSON |
| package.json | `js-yaml` dep | Never imported; YAML config is obsolete |
| package.json | `@2captcha/captcha-solver` dep | Never imported; code uses raw `fetch` to `api.2captcha.com` |
| src/screens/SettingsTab.jsx:20 | `maskApiKey()` | Defined, never called |
| electron/main.js:346 | `is24.password` field | Stored in config, never read for auth (login is manual) |
| electron/chrome.js | `hideBrowser()` | Intentional no-op stub |
| config/autoapply.config*.yaml | whole files | Obsolete v2 format (per AGENTS.md "DO NOT USE") |

---

## Antipatterns

1. **Silent catch-all error handling (~64 sites).** Empty `catch {}` / `.catch(()=>{})` across main, daemon, contactor, and React. Hurts: every swallowed CDP/DB/IPC failure is invisible, undermining the support-bundle diagnostics. Fix: a logged-catch helper; no-ops must be commented.
2. **DB-connection-per-IPC with no `try/finally`.** main.js re-opens/migrates/closes per call and leaks on throw. Hurts: handle leaks + WAL contention with the daemon. Fix: shared connection or `finally`-close.
3. **Duplicated `normalizeStats`.** Verbatim copy in `App.jsx:18` and `SearchTab.jsx:88`. Hurts: stats-shape logic drifts in two places. Fix: extract to `src/shared/`.
4. **God-module daemon with global mutable coordination.** `applyPaused`, `pauseResumeTime`, `consecutiveCaptchas`, `contactor`, `lastTick`, `cdpFailCount`, `currentConfig` are module globals shared by two loops. Hurts: untestable, implicit ordering. Fix: encapsulate in a `DaemonState` class with an injected logger.
5. **Stringly-typed outcome classification.** `LIKE '%captcha%'`/`'%premium%'`/`'%Suchen+%'` over free-text `detail` is duplicated across db.js, daemon.js, HistoryTab.jsx, and userErrors.js. Hurts: one wording change silently breaks stats/badges. Fix: persist a canonical enum column and key everything off it.

---

## Best Practices Scorecard

| Area | Grade | One-sentence gap | One-sentence fix |
|------|-------|------------------|------------------|
| Error handling | C- | ~64 silent swallowers hide real failures | Logged-catch helper; remove bare `catch {}` |
| State management | B | Zustand is clean but `normalizeStats` is duplicated and stats logic leaks into views | Centralize stats shaping in one module |
| IPC design | C | Clean surface, but every handler reopens/leaks a DB connection | Shared connection + `try/finally` |
| DB access | C+ | Connection churn, UTC/localtime split, 8×COUNT per stats call | One aggregate query + single connection |
| Config | B | Hot-reload + deep-merge are good, but secrets are plaintext | Encrypt secrets via `safeStorage` |
| Logging | C+ | Daemon log is structured (0 `console.*`), but main uses `console` and catches drop context | Unify on the `log()` helper |
| Testing | D | 158 logic tests, but zero for daemon, IPC, Chrome, or React | Add daemon-loop + IPC + component tests |
| Type safety | C | Plain JS, sparse JSDoc, stringly-typed outcomes | Add JSDoc types or migrate hot paths to TS |
| CI/CD | B | Tests + build + whitespace on macOS only; release is `workflow_dispatch` | Add Linux/Windows CI lanes |

---

## Security

1. **Electron 34 — 1 high advisory (`npm audit`).** Worst 3: **high** | AppleScript injection in `app.moveToApplicationsFolder` (macOS) `GHSA-5rqw-r77c-jp79` | **high** | OOB read in second-instance IPC, macOS/Linux (app uses `second-instance`) `GHSA-3c8v-cfp5-9885` | **high** | service worker spoofs `executeJavaScript` IPC replies `GHSA-xj5x-m3f3-5x3h`. Fix: upgrade Electron (breaking; test the contextBridge + native module rebuild).
2. **`webPreferences.sandbox: false` + unrestricted `shell.openExternal`.** electron/main.js:~690, electron/preload.cjs (bottom). Renderer isn't OS-sandboxed and `openExternal` forwards any renderer-supplied URL (`file://`, `smb://`, …). Mitigated (BrowserWindow loads only local content) but below best practice. Fix: `sandbox: true`; allowlist `https`/`mailto` in `openExternal`.
3. **Plaintext secrets in config.json** (see Critical #2).
4. **Un-redacted PII in per-entry debug bundles** (see Critical #1).
5. **CSV formula injection in history export.** src/screens/HistoryTab.jsx:~520. `title`/`address` (attacker-influenceable listing data) are quote-escaped but not formula-guarded; `expose_id`/`outcome`/`sent_at`/`filter_id` are written unescaped (low risk, app-controlled). Fix: prefix cells starting with `= + - @` with `'`.

_Logs/config in bundles are already redacted via `redact()` / `redactSupportText()` — that part is sound._

---

## Performance

1. **Stats query fan-out.** `getStats()` and `getTodayStats()` each run ~8 separate `COUNT(*)` scans; SearchTab refreshes every 30 s **and** on every `stats`/`listing` event → ~16 full-table counts per refresh, scaling with history size. Fix: collapse into one `SELECT` with conditional `SUM(CASE …)`; cache between events.
2. **DB connection churn.** Opening + `_migrate` + closing a SQLite handle on every IPC/stat poll is needless syscall/WAL overhead alongside the daemon's connection. Fix: reuse one connection in main.
3. **4 MB synchronous HTML dumps per apply.** `writeFileSync` of full page content (plus full-page screenshots) inside `apply()` blocks the daemon event loop briefly each time and grows disk unbounded. Fix: debug-flag-gate, write async, and rotate.

---

## Test Coverage Map

| Module | Has tests? | Biggest gap |
|--------|-----------|-------------|
| engine/db.js | Yes (73) | WAL/concurrent-writer behavior; UTC/localtime; NULL `filter_id` after delete |
| engine/url-translator.js | Yes (63) | Missing fetch-timeout, empty `expose_id`, malformed API payloads |
| engine/is24-contactor.js | Partial (22, logic only) | `apply()` orchestration, `_fillForm`, `_solveCaptcha`, CDP reconnect untested |
| engine/daemon.js | No | poll/apply loops, pause + captcha-wall, IPC patches, auto-restart untested |
| electron/main.js | No | IPC handlers, support-bundle redaction, `deepMerge` config untested |
| electron/chrome.js | No | launch/login/visibility/restart-throttle untested |
| src/** (React + store) | No | No component or Zustand tests at all |

---

## Action Plan

| # | Priority | What | Files | Est. LOC | Test |
|---|----------|------|-------|----------|------|
| 1 | P0 | Redact/strip form PII from HTML before bundling (or exclude raw HTML) | main.js, is24-contactor.js | 40 | Bundle a dump, assert no email/phone |
| 2 | P0 | Encrypt secrets via `safeStorage` (or fix README) | main.js, README.md | 50 | Round-trip encrypt/decrypt |
| 3 | P0 | Add `AbortSignal.timeout` to poll fetches | url-translator.js | 6 | Mock a hung fetch, assert timeout |
| 4 | P1 | Declare/remove `setConfigAppliedFlash` | SearchTab.jsx | 5 | Render + dispatch event |
| 5 | P1 | `try/finally`-close (or share) DB connections | main.js | 60 | Force handler throw, assert no leak |
| 6 | P1 | Logged-catch helper; replace bare `catch {}` | electron/, engine/, src/ | 120 | Lint rule: no empty catch |
| 7 | P1 | Persist captcha-wall pause to flag | daemon.js | 15 | Restart mid-cooldown stays paused |
| 8 | P1 | Filter empty-`expose_id` listings | url-translator.js | 3 | Feed ad row, assert dropped |
| 9 | P2 | Unify today-stat timezone to localtime | db.js | 8 | Midnight-boundary count test |
| 10 | P2 | Rotate/cap debug artifacts; debug-flag HTML dumps | is24-contactor.js, daemon.js | 40 | Assert prune keeps N newest |
| 11 | P2 | Single aggregate stats query | db.js | 40 | Compare to current per-count results |
| 12 | P2 | Allowlist `openExternal`; CSV formula-guard | preload.cjs, HistoryTab.jsx | 20 | Reject `file://`; assert `'`-prefix |
| 13 | P2 | Daemon-loop + IPC integration tests | test/ | 200 | New suites |
| 14 | P3 | Upgrade Electron; remove dead deps | package.json | 10 | Full smoke + dist |
| 15 | P3 | Extract shared `normalizeStats` | App.jsx, SearchTab.jsx, shared/ | 25 | Reuse existing assertions |

---

## Appendix: Top-2 Refactor Examples

### A. Centralize DB access (fixes connection churn + leaks)

```js
// electron/db-service.js — one connection, opened once.
import { HomelanderDB } from '../engine/db.js';
let _db = null;
export function db() { return (_db ??= new HomelanderDB(DB_PATH)); }
export function withDb(fn) {            // optional helper for symmetry
  return fn(db());                      // no per-call open/close
}

// main.js — before:
ipcMain.handle('filters:list', async () => {
  const { HomelanderDB } = await import('../engine/db.js');
  const db = new HomelanderDB(DB_PATH);
  const filters = db.getFilters();      // throws here → db never closed
  db.close();
  return { filters, error: null };
});

// main.js — after:
ipcMain.handle('filters:list', async () => {
  try { return { filters: db().getFilters(), error: null }; }
  catch (err) { return { filters: [], ...gracefulFailure('filters:list', err, { code: 'DATABASE_ERROR' }) }; }
});
```

**Migration:** 1) Add `db-service.js` exporting one lazy connection. 2) Replace each handler's `import + new + close` with `db()`. 3) Close the single connection in `before-quit`. 4) Keep the daemon's own connection (separate process). 5) Run db smoke + IPC tests.

### B. Logged-catch helper (kills silent swallowing)

```js
// shared/logCatch.js
export function swallow(err, context, log = console.error) {
  log(`[swallow] ${context}: ${err?.message || err}`);   // one line, never throws
}

// before — engine/is24-contactor.js (×64 across the tree)
try { await this.page.screenshot({ path }); } catch {}

// after
try { await this.page.screenshot({ path }); }
catch (err) { swallow(err, 'screenshot', log); }
```

**Migration:** 1) Add `swallow()` wired to the daemon `log()` and main `logRawError()`. 2) Codemod bare `catch {}` / `.catch(()=>{})` to `swallow(err, '<site>')`. 3) Keep genuine no-ops but annotate `// intentional: best-effort`. 4) Add an ESLint `no-empty` (allowEmptyCatch:false) gate. 5) Re-run unit tests.
