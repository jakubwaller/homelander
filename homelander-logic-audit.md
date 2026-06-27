# Homelander application logic audit

Scope audited:
- `engine/`: `daemon.js`, `db.js`, `is24-contactor.js`, `url-translator.js`
- `electron/`: `main.js`, `chrome.js`, `db-service.js`, `preload.cjs`
- `src/screens/`: `AddSearchDialog.jsx`, `HistoryTab.jsx`, `SearchTab.jsx`, `SettingsTab.jsx`, `SetupWizard.jsx`
- `src/components/`: `ActivityFeed.jsx`, `FilterCard.jsx`, `StatusDot.jsx`

Certainty: ~90% overall. Race findings depend on runtime timing.

## 1. Deleted/paused filter can keep processing because “still enabled” ignores `archived`

Severity: high

Files / lines:
- `engine/daemon.js:189-192`
- `engine/daemon.js:498-552`
- `engine/db.js:148-153`

User sees:
- User deletes a search while one of its listings is being applied.
- The card disappears from UI.
- Daemon can still finish applying that listing, because the mid-loop guard only checks `enabled`, not `archived`.

Should happen:
- Deleting a search should stop new polling/applying for that search immediately.
- Anything not yet submitted should be abandoned/requeued/skipped according to product semantics.

Root cause:

```js
function filterIsStillEnabled(db, filterId) {
  const current = db.getFilter(filterId);
  return !!current?.enabled;
}
```

`removeFilter()` sets `archived = 1` but leaves `enabled` unchanged. So `filterIsStillEnabled()` returns true for archived filters.

Specific fix:

```js
function filterIsStillEnabled(db, filterId) {
  const current = db.getFilter(filterId);
  return !!current?.enabled && !current?.archived;
}
```

Also after claiming a listing, re-check before submit:

```js
if (!filterIsStillEnabled(db, filter.id)) {
  db.db.prepare("UPDATE listings SET status = 'seen' WHERE hash = ? AND status = 'processing'").run(listing.hash);
  continue;
}
```

## 2. “Mark as already applied” / skip exposé does not stop a listing currently being auto-applied

Severity: high

Files / lines:
- `engine/db.js:231-253`
- `engine/db.js:237-243`
- `engine/daemon.js:532-552`
- `src/screens/SearchTab.jsx:245-267`
- `electron/main.js:1144-1152`

User sees:
- User pastes an exposé URL into “already applied”.
- UI says success: `✓ Bereits beworben`.
- If daemon already claimed that listing as `processing`, DB update skips it:

```sql
WHERE expose_id = ? AND status != 'processing'
```

- Daemon still submits the application.

Should happen:
- If user marks/skips a listing as already applied, the daemon must not submit it, including during the processing window before final submit.

Root cause:
- `markAlreadyApplied()` returns `{ found: true }` even if the update changed zero rows because the row is `processing`.
- The UI treats that as success.
- There is no cancellation token / final DB guard inside `applyOne()` before submit.

Specific fix:
- Return actual `changes` from `markAlreadyApplied()`.
- If row is `processing`, set a cancellation marker instead of silently doing nothing.
- Add a final pre-submit guard in `IS24Contactor.apply()` or immediately before calling it.

Minimal DB-side change:

```js
const info = this.db.prepare(`
  UPDATE listings
  SET outcome = 'MANUAL',
      detail = 'applied manually',
      failure_reason = NULL
  WHERE expose_id = ?
`).run(id);

return { found, exposeId: id, changed: info.changes };
```

Then in daemon before submit and ideally inside contactor before clicking submit:

```js
if (db.isManuallyApplied(listing.expose_id)) {
  db.db.prepare(`
    UPDATE listings
    SET status = 'sent', outcome = 'MANUAL',
        detail = 'applied manually',
        sent_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE hash = ?
  `).run(listing.hash);
  continue;
}
```

## 3. Skip exposé can erase real history/stats for already processed rows

Severity: medium-high

Files / lines:
- `engine/db.js:237-243`
- `engine/db.js:304-330`
- `engine/db.js:332-365`

User sees:
- User marks an exposé as “already applied”.
- If the exposé already had a real outcome like `SENT`, `FAIL`, `PREMIUM`, or `DEACTIVATED`, it is overwritten as `MANUAL`.
- It disappears from history and aggregate counts change because history/stats intentionally exclude `MANUAL`.

Should happen:
- Skip exposé should prevent future auto-apply, not rewrite past outcomes.

Root cause:
`markAlreadyApplied()` updates any non-processing row with the same `expose_id`:

```sql
UPDATE listings
SET status = 'sent', outcome = 'MANUAL', detail = 'applied manually',
  sent_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE expose_id = ? AND status != 'processing'
```

History excludes manual rows:

```sql
WHERE outcome IS NOT NULL AND outcome != 'MANUAL'
```

Stats exclude manual rows from processed/sent totals.

Specific fix:
Only convert pending queue rows:

```sql
UPDATE listings
SET status = 'sent',
    outcome = 'MANUAL',
    detail = 'applied manually',
    sent_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE expose_id = ?
  AND status = 'seen'
```

If no pending row exists, insert a separate MANUAL skip stub, but do not overwrite existing processed rows.

Best schema fix: add a dedicated table:

```sql
CREATE TABLE IF NOT EXISTS manual_skips (
  expose_id TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```

Then make polling/apply check `manual_skips`. This separates “skip future” from application history.

## 4. App status can report “running” while daemon is actually blocked by perimeter captcha

Severity: high

Files / lines:
- `electron/main.js:753-755`
- `electron/main.js:662-666`
- `electron/main.js:943-945`
- `src/App.jsx:107-114`
- `src/App.jsx:231-238`

User sees:
- Perimeter captcha event sets UI to captcha-needed initially.
- Later `daemon:status` / stats normalization can report `running`, because `effectiveDaemonStatus()` does not preserve `perimeter_captcha`.
- Header can say active/running even though the pause flag blocks daemon loops.

Should happen:
- Status should remain `perimeter_captcha` until user explicitly resumes after solving captcha.

Root cause:
`handleDaemonEvent()` sets:

```js
daemonStatus = 'perimeter_captcha';
```

But `effectiveDaemonStatus()` only preserves:

```js
if (daemonStatus === 'paused' || daemonStatus === 'session_expired' || daemonStatus === 'restarting') return daemonStatus;
return 'running';
```

Specific fix:

```js
function effectiveDaemonStatus() {
  if (daemonStopping) return 'stopped';
  if (!daemonAlive()) return 'stopped';
  if (
    daemonStatus === 'paused' ||
    daemonStatus === 'session_expired' ||
    daemonStatus === 'perimeter_captcha' ||
    daemonStatus === 'restarting'
  ) return daemonStatus;
  return 'running';
}
```

Also update the comment at `electron/main.js:78` to include `perimeter_captcha`.

## 5. Daemon restart resets `last_polled_at` for every filter, reapplying first-poll cap repeatedly

Severity: high

Files / lines:
- `engine/daemon.js:891-896`
- `engine/daemon.js:639-645`
- `engine/daemon.js:719-725`

User sees:
- App starts, each search only gets first 10 listings.
- Daemon crashes/restarts or user restarts app.
- Same “first poll” behavior applies again because all filters are reset to `last_polled_at = NULL`.
- This can cause fresh listings beyond the first 10 to be ignored until a later successful poll, and it makes startup behavior unexpectedly different from steady-state polling.

Should happen:
- First-poll cap should apply only to a genuinely new filter or explicit “fresh start” state, not every daemon startup.

Root cause:
Startup unconditionally runs:

```sql
UPDATE filters SET last_polled_at = NULL
```

Then poll logic treats every filter as first-poll:

```js
const listingsToInsert = filter.last_polled_at
  ? dedupedListings
  : dedupedListings.slice(0, Math.max(0, firstPollLimit - filterNew));
```

Specific fix:
Add an explicit DB column, e.g. `first_poll_done INTEGER DEFAULT 0`, or use `created_at` + `last_polled_at` without resetting it.

Example:

```sql
ALTER TABLE filters ADD COLUMN first_poll_done INTEGER NOT NULL DEFAULT 0;
```

Poll logic:

```js
const isFirstPoll = !filter.first_poll_done;
const listingsToInsert = isFirstPoll
  ? dedupedListings.slice(0, Math.max(0, firstPollLimit - filterNew))
  : dedupedListings;

...

db.updateFilter(filter.id, {
  last_polled_at: new Date().toISOString(),
  total_seen: (filter.total_seen || 0) + filterNew,
  first_poll_done: 1,
});
```

Remove the startup reset entirely.

## 6. Browser/CDP crash mid-apply burns the listing as failed instead of retrying safely

Severity: medium-high

Files / lines:
- `engine/daemon.js:331-360`
- `engine/daemon.js:337-348`
- `engine/daemon.js:884-889`

User sees:
- Chrome/CDP dies mid-apply.
- Listing becomes `FAIL` with `ERROR: ...`.
- It is no longer pending and will not auto-retry.
- User must manually retry from history, even though the failure may be pure infrastructure, not a listing/application failure.

Should happen:
- If CDP/browser dies before confirmed submit, listing should return to `seen` or become a retryable transient state.
- User should not lose an application opportunity because Chrome crashed.

Root cause:
The catch block immediately marks failed:

```js
db.markSent(listing.hash, 'FAIL', `ERROR: ${errMsg}`, 'error');
```

Only after that it detects CDP-fatal errors and nulls the contactor:

```js
if (cdpFatal.test(errMsg) || ...) {
  contactor = null;
}
```

Startup only resets `processing` rows, but this row is no longer `processing`; it is `failed`.

Specific fix:
Detect CDP-fatal first. For fatal browser failures, reset to `seen` instead of `FAIL` unless there is evidence the submit succeeded.

```js
const isCdpFatal = cdpFatal.test(errMsg) || (contactor?.browser && !contactor.browser.isConnected());

if (isCdpFatal) {
  db.db.prepare(`
    UPDATE listings
    SET status = 'seen',
        outcome = NULL,
        detail = NULL,
        failure_reason = NULL,
        sent_at = NULL
    WHERE hash = ? AND status = 'processing'
  `).run(listing.hash);
  contactor = null;
  emit({ type: 'transient_apply_error', exposeId: listing.expose_id, detail: errMsg });
  return;
}

db.markSent(listing.hash, 'FAIL', `ERROR: ${errMsg}`, 'error');
```

## 7. Manual poll writes from Electron main while daemon poll loop can write same DB concurrently

Severity: medium-high

Files / lines:
- `electron/main.js:947-1010`
- `electron/main.js:991-994`
- `engine/daemon.js:571-678`
- `engine/daemon.js:655-659`
- `electron/db-service.js:1-3`
- `electron/db-service.js:10-17`

User sees:
- Clicking “Jetzt prüfen” near an automatic poll can produce inconsistent `total_seen`.
- In unlucky timing, the main process and daemon both fetch/insert/update the same filter.
- Primary-key insert dedupe prevents duplicate listings, but `total_seen` can be overwritten with stale `(filter.total_seen || 0) + inserted`.

Should happen:
- Only one owner should perform poll writes.
- `total_seen` should be incremented atomically.

Root cause:
Despite `db-service.js` claiming renderer queries only/read-only, Electron main directly writes:

```js
db().insertListings(...)
db().updateFilter(filter.id, {
  last_polled_at: new Date().toISOString(),
  total_seen: (filter.total_seen || 0) + allInserted,
});
```

Daemon also writes the same fields:

```js
db.updateFilter(filter.id, {
  last_polled_at: new Date().toISOString(),
  total_seen: (filter.total_seen || 0) + filterNew,
});
```

Both use stale `filter.total_seen` read before polling.

Specific fix:
- Route manual poll through daemon IPC only; remove duplicate fetch/write implementation from Electron main.
- Or add a DB transaction + atomic increment method:

```js
incrementFilterSeen(id, delta) {
  this.db.prepare(`
    UPDATE filters
    SET last_polled_at = ?,
        total_seen = COALESCE(total_seen, 0) + ?
    WHERE id = ?
  `).run(new Date().toISOString(), delta, id);
}
```

Then replace both stale update sites.

Also set SQLite busy timeout in `HomelanderDB` constructor:

```js
this.db.pragma('busy_timeout = 5000');
```

## 8. “Processed X/Y” does not update live after an apply finishes

Severity: medium

Files / lines:
- `src/App.jsx:84-91`
- `src/App.jsx:93-105`
- `src/screens/SearchTab.jsx:147-164`
- `engine/daemon.js:319-329`
- `engine/daemon.js:351-360`

User sees:
- Live feed immediately shows a sent/failed item.
- Top stats / per-filter processed counts may remain stale until:
  - next daemon stats event,
  - next poll cycle,
  - or SearchTab’s 30s refresh.

Should happen:
- When a listing event arrives, processed counters should update immediately or the daemon should emit fresh stats after each listing.

Root cause:
Renderer `onListing` only adds activity:

```js
unsubs.push(window.homelander.onListing((data) => {
  addActivity(...)
}));
```

It does not refresh stats/filters. Daemon emits `listing` events after apply, but does not emit stats after each listing. Stats are emitted after poll cycles and some queue/retry actions.

Specific fix, daemon-side preferred:

```js
await applyOne(listing, filter.id, db);
emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: new Date(nextPollDueAt).toISOString() });
```

Renderer-side fallback:

```js
unsubs.push(window.homelander.onListing(async (data) => {
  addActivity(...);
  const [{ stats }, { filters }] = await Promise.all([
    window.homelander.getTodayStats(),
    window.homelander.getFilters(),
  ]);
  if (stats) setStats(normalizeStats(stats));
  if (filters) setFilters(filters);
}));
```

## 9. Initial live feed order is reversed on app startup

Severity: low

Files / lines:
- `engine/db.js:405-412`
- `src/App.jsx:48-65`
- `src/stores/appStore.js:29-32`
- `src/components/ActivityFeed.jsx:181-183`

User sees:
- On app startup, recent activity can appear oldest-first among the loaded recent items.
- New live items then appear at top, so ordering behavior changes after startup.

Should happen:
- Initial feed should show newest first consistently.

Root cause:
DB returns newest first:

```sql
ORDER BY COALESCE(sent_at, discovered_at) DESC, rowid DESC
```

But App loops in that order and prepends each item:

```js
for (const item of recent) {
  addActivity(...)
}
```

Store prepends:

```js
activity: [item, ...state.activity].slice(0, 200)
```

So `[newest, older, oldest]` becomes `[oldest, older, newest]`.

Specific fix:
Either reverse before adding:

```js
for (const item of [...recent].reverse()) {
  addActivity(...)
}
```

Or add a store method that sets initial activity in given order:

```js
setActivity: (items) => set({ activity: items.slice(0, 200) })
```

## 10. Retry UI claims “re-queued” even when daemon has not confirmed success

Severity: low-medium

Files / lines:
- `src/components/ActivityFeed.jsx:128-135`
- `src/screens/HistoryTab.jsx:573-579`
- `electron/main.js:1031-1047`
- `engine/daemon.js:760-773`

User sees:
- User clicks retry.
- UI immediately shows `Re-queued →`.
- If daemon later reports `retry_error` or listing was not found, UI already showed success.

Should happen:
- UI should show queued only after confirmed daemon result.
- Failed retry should show an error.

Root cause:
Renderer dispatches local success regardless of returned result:

```js
await window.homelander.retryListing(exposeId);
window.dispatchEvent(new CustomEvent('homelander:retry-queued', ...));
```

When daemon is running, Electron main only sends IPC and returns `{ ok: true }` without waiting for `retry_queued`/`retry_error`.

Specific fix:
- Remove optimistic local `homelander:retry-queued` dispatch.
- Listen only to daemon event `retry_queued`.
- Add handling for `retry_error`.

Renderer:

```js
const result = await window.homelander.retryListing(exposeId);
if (!result?.ok) showError(...);
// do not dispatch retry_queued locally
```

Main process should optionally correlate request IDs if synchronous confirmation is needed.

## 11. `total_seen` and per-filter counters are semantically mixed with “today” counters

Severity: low-medium

Files / lines:
- `engine/db.js:110-123`
- `src/components/FilterCard.jsx:85-90`
- `src/screens/SearchTab.jsx:301-311`
- `src/shared/normalizeStats.js:10-21`

User sees:
- FilterCard shows:

```jsx
processed_count / (today_seen ?? total_seen)
```

- Because `today_seen` is always returned by SQL, denominator is always “today-ish”, never `total_seen`.
- Top dashboard also uses normalized `seen = total + seen_unapplied`, but SearchTab label is just “Today”.
- This can be confusing when comparing per-card counts, dashboard counts, and history.

Should happen:
- UI should clearly separate:
  - pending queue,
  - processed today,
  - total discovered,
  - all-time processed.

Root cause:
`getFilters()` returns both all-time-ish `total_seen` and daily aggregate `today_seen`; UI always prefers `today_seen` due to nullish coalescing:

```jsx
{filter.processed_count || 0}/{(filter.today_seen ?? filter.total_seen) || 0}
```

Since SQL always returns a numeric `today_seen`, fallback is dead code.

Specific fix:
Make the label explicit and compute directly.

For today:

```sql
today_total = today_processed + today_pending
```

For all-time:

```sql
all_time_total = total_seen
```

Then render:

```jsx
Heute: {filter.today_processed}/{filter.today_total}
Gesamt: {filter.processed_all_time}/{filter.total_seen}
```

Or remove `total_seen` from this card to avoid pretending it is the fallback.
