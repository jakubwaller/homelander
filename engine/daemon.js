#!/usr/bin/env node
// Homelander Daemon — polls IS24 mobile API for new listings,
// then auto-applies to them via Chrome CDP. Runs continuously.
//
// Two independent async loops:
//   pollLoop  — discovers new listings on a fixed schedule
//   applyLoop — applies to pending listings round‑robin (respects pauses)
//
// Usage: node engine/daemon.js --db=<path> --cdp-url=<url> --config=<path>
//
// Communicates status via stdout JSON lines:
//   {"type":"stats",...}
//   {"type":"listing","outcome":"SENT",...}
//   {"type":"captcha_wall","consecutive":5}
//   {"type":"paused","reason":"captcha_wall","resume_in_sec":900}
//   {"type":"resumed"}
//   {"type":"error","message":"..."}
//   {"type":"poll_error","filter_id":"...","error":"..."}
//   {"type":"ready_for_restart"}  // emitted when graceful restart is ready

import { readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse CLI args
const { values: args } = parseArgs({
  options: {
    db: { type: 'string' },
    'cdp-url': { type: 'string', default: 'http://localhost:9222' },
    config: { type: 'string' },
    'poll-interval': { type: 'string', default: '120' }, // seconds
    'dry-run': { type: 'boolean', default: false },
  },
});

const DB_PATH = args.db || join(process.env.HOME || '/tmp', '.homelander', 'homelander.db');
const CDP_URL = args['cdp-url'];
const CONFIG_PATH = args.config;
const DRY_RUN = args['dry-run'];
const PAUSE_FLAG = join(dirname(DB_PATH), '.apply-paused');
const DAEMON_LOG = join(dirname(DB_PATH), 'daemon.log');

// Mutable poll interval — updated via IPC when user changes it in Settings
let pollIntervalSec = parseInt(args['poll-interval'], 10);
let nextPollDueAt = 0; // ms timestamp; reset by settings save and manual poll

// Dynamic imports
const { HomelanderDB } = await import('./db.js');
const { IS24Contactor, DEBUG } = await import('./is24-contactor.js');
const { fetchListings } = await import('./url-translator.js');

// ── Helpers ────────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  process.stderr.write(line + '\n');
  try { appendFileSync(DAEMON_LOG, line + '\n', 'utf8'); } catch (err) { swallow(err, 'daemon/append-log'); }
}
/** Logged-catch replacement for bare catch {} — never throws, always logs to daemon log. */
function swallow(err, context) {
  try { log(`[swallow] ${context}: ${err?.message || err}`); } catch {}
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resetNextPollDue() {
  nextPollDueAt = Date.now() + pollIntervalSec * 1000;
  return new Date(nextPollDueAt).toISOString();
}

async function sleepUntilNextPoll() {
  while (true) {
    const remaining = nextPollDueAt - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(1000, remaining));
  }
}

function jitter(min, max) {
  return sleep(min + Math.random() * (max - min));
}

function personaliseMessage(template, listing) {
  return template
    .replace(/\{\{title\}\}/g, listing.title || '')
    .replace(/\{\{address\}\}/g, listing.address || '')
    .replace(/\{\{name\}\}/g, `${listing._contact?.vorname || ''} ${listing._contact?.nachname || ''}`.trim());
}

/** Shallow merge for config patches received via IPC. */
function mergePatch(target, patch) {
  for (const key of Object.keys(patch)) {
    if (patch[key] !== undefined) {
      target[key] = patch[key];
    }
  }
}

/** Check filesystem pause flag — belt-and-suspenders for IPC pauses. */
function checkPauseFlag() {
  try {
    return existsSync(PAUSE_FLAG);
  } catch {
    return false;
  }
}

/** Write the filesystem pause flag so restarts remember the pause. */
function writePauseFlag(reason = 'manual') {
  try {
    writeFileSync(PAUSE_FLAG, JSON.stringify({ paused_at: new Date().toISOString(), reason }), 'utf8');
  } catch (err) {
    log(`Failed to write pause flag: ${err.message}`);
  }
}

/** Remove the filesystem pause flag. */
function removePauseFlag() {
  try {
    unlinkSync(PAUSE_FLAG);
  } catch {
    // file doesn't exist — that's fine
  }
}

function filterIsStillEnabled(db, filterId) {
  const current = db.getFilter(filterId);
  return !!current?.enabled;
}

// ── Config loading ─────────────────────────────────────────────

function loadConfig() {
  if (!CONFIG_PATH || !existsSync(CONFIG_PATH)) {
    log('ERROR: config file not found at ' + CONFIG_PATH);
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

// ── Shared state between loops ─────────────────────────────────
// JS is single-threaded — no locks needed.

let applyPaused = false;
let pauseResumeTime = null;   // null = manual pause; timestamp = auto-resume
let consecutiveCaptchas = 0;

// contactor is a shared reference so the apply loop can reconnect
let contactor = null;

// last-tick timestamp for sleep/wake detection — both loops update this
let lastTick = Date.now();

// consecutive CDP connect failures — escalate to Electron after threshold
let cdpFailCount = 0;

// Mutable config — all fields hot-reload without restart
let currentConfig = null;

// ── Apply one listing ──────────────────────────────────────────

async function applyOne(listing, filterId, db) {
  // Use currentConfig so template/captcha edits take effect immediately
  const message = personaliseMessage(currentConfig.message_template, {
    ...listing,
    _contact: currentConfig.persona,
  });

  if (DRY_RUN) {
    log(`  [DRY RUN] Would apply to: ${listing.title} (${listing.expose_id})`);
    emit({
      type: 'listing',
      outcome: 'DRY_RUN',
      exposeId: listing.expose_id,
      title: listing.title,
      price: listing.price,
      address: listing.address,
      imageUrl: listing.image_url,
      detail: 'dry run — not sent',
    });
    return;
  }

  try {
    // ── Per-form login check — scans ALL open IS24 tabs, opens one if needed ──
    if (!applyPaused && contactor && contactor.browser && contactor.browser.isConnected()) {
      try {
        const loggedIn = await contactor.checkIS24LoginAnyTab();
        if (!loggedIn) {
          log('*** IS24 login check failed before form submit — pausing apply ***');
          emit({ type: 'session_expired', reason: 'IS24 login check failed — no logged-in IS24 tab found' });
          applyPaused = true;
          pauseResumeTime = null;
          writePauseFlag('session_expired');
          // Navigate the persistent page to IS24 homepage so the user can log in
          try { await contactor.page.goto('https://www.immobilienscout24.de/', { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch (err) { swallow(err, 'apply/session-expiry-redirect'); }
          return;
        }
      } catch (_) { /* best-effort; don't disrupt apply */ }
    }

    const result = await contactor.apply(
      listing.expose_id,
      message,
      currentConfig.captcha?.api_key || '',
      currentConfig.browser?.max_tabs || 5
    );

    if (result.success) {
      const captchaSolved = result.captcha?.solved || result.captcha?.attempts > 0;
      const failureReason = captchaSolved ? 'captcha_solved' : '';
      db.markSent(listing.hash, 'SENT', result.detail || 'modal ✓', failureReason);
      consecutiveCaptchas = 0;
      log(`  ✓ SENT | ${listing.expose_id} | ${listing.title} | ${result.detail || ''}${captchaSolved ? ' (captcha solved)' : ''}`);
      emit({
        type: 'listing',
        outcome: 'SENT',
        exposeId: listing.expose_id,
        title: listing.title,
        price: listing.price,
        address: listing.address,
        imageUrl: listing.image_url,
        detail: result.detail || '',
        failureReason,
      });
    } else {
      const reason = result.reason || '';
      const reasonLower = reason.toLowerCase();
      const isDeactivated = reasonLower.includes('deactivated');
      const isPremium = reasonLower.includes('premium') || reasonLower.includes('suchen+');
      const isSessionExpired = reasonLower.includes('session_expired');
      const isError = reason.startsWith('ERROR:');
      const failureReason = isSessionExpired ? 'session_expired'
        : isDeactivated ? 'deactivated'
        : isPremium ? 'premium'
        : reasonLower.includes('captcha') ? 'captcha'
        : reasonLower.includes('server_error') || reasonLower.includes('server error') ? 'server_error'
        : reasonLower.includes('no_form') ? 'no_form'
        : isError ? 'error'
        : 'unknown';

      const outcome = isDeactivated ? 'DEACTIVATED' : isPremium ? 'PREMIUM' : 'FAIL';
      db.markSent(listing.hash, outcome, reason, failureReason);
      const logIcon = isDeactivated ? '◌' : isPremium ? '💎' : '✗';
      log(`  ${logIcon} ${outcome} | ${listing.expose_id} | ${listing.title} | ${reason}`);

      if (failureReason === 'captcha') {
        consecutiveCaptchas++;
      } else {
        consecutiveCaptchas = 0;
      }

      if (isSessionExpired) {
        log('*** IS24 SESSION EXPIRED — pausing apply ***');
        emit({ type: 'session_expired', reason });
        applyPaused = true;
        pauseResumeTime = null;
        writePauseFlag('session_expired');
        // Navigate to IS24 homepage so the user can log in
        try { await contactor.page?.goto('https://www.immobilienscout24.de/', { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch (err) { swallow(err, 'apply/session-expiry-redirect2'); }
      }

      emit({
        type: 'listing',
        outcome,
        exposeId: listing.expose_id,
        title: listing.title,
        price: listing.price,
        address: listing.address,
        imageUrl: listing.image_url,
        detail: reason,
        failureReason,
      });
    }
  } catch (err) {
    const errMsg = err?.message || String(err);
    log(`  ERROR | ${listing.expose_id} | ${errMsg}`);
    db.markSent(listing.hash, 'FAIL', `ERROR: ${errMsg}`, 'error');
    consecutiveCaptchas = 0;

    // CDP-level errors mean the browser connection is toast — null the
    // contactor so the next loop iteration forces a full reconnect. IS24
    // form-fill errors (TypeError, timeout loading page) are left alone.
    const cdpFatal = /Target closed|Session closed|Protocol error|WebSocket is not open|Connection closed|Detached from target|Browser has been disconnected/i;
    if (cdpFatal.test(errMsg) || (contactor?.browser && !contactor.browser.isConnected())) {
      log('  CDP connection lost — nulling contactor for reconnect');
      contactor = null;
    }

    emit({
      type: 'listing',
      outcome: 'FAIL',
      exposeId: listing.expose_id,
      title: listing.title,
      price: listing.price,
      address: listing.address,
      imageUrl: listing.image_url,
      detail: `ERROR: ${err.message}`,
    });
  }
}

// ── Apply loop ─────────────────────────────────────────────────
// Runs continuously, processing one listing per enabled filter per round.
// Respects applyPaused / captcha wall / session expiry / pendingRestart.
// Polling is completely independent — it runs in pollLoop().

async function applyLoop(db) {
  // Restore captcha-wall pause if daemon restarted during cooldown
  try {
    if (existsSync(PAUSE_FLAG)) {
      const data = JSON.parse(readFileSync(PAUSE_FLAG, 'utf8'));
      if (data?.reason === 'captcha_wall') {
        applyPaused = true;
        pauseResumeTime = Date.now() + 15 * 60 * 1000;  // conservative restart
        log('Restored captcha-wall pause from flag');
        emit({ type: 'paused', reason: 'captcha_wall_restored', resume_in_sec: 900 });
      }
    }
  } catch (err) { swallow(err, 'daemon/restore-captcha-pause'); }

  // Prune debug artifacts on startup (keep 50 most recent per subdir)
  DEBUG.prune(50);

  log('Apply loop started');

  while (true) {
    // ── Detect wake from sleep — force CDP reconnect ──────────
    if (Date.now() - lastTick > (pollIntervalSec * 3000)) {
      log(`Time jump detected (${Math.round((Date.now() - lastTick) / 1000)}s) — forcing CDP reconnect`);
      contactor = null;
    }
    lastTick = Date.now();

    // ── Wait if paused ───────────────────────────────────────
    // Honour both in-memory flag (IPC set) and filesystem flag (belt-and-suspenders)
    if (applyPaused || checkPauseFlag()) {
      if (!applyPaused && checkPauseFlag()) {
        // Filesystem flag found but in-memory not set — sync
        applyPaused = true;
        pauseResumeTime = null;
        log('Apply paused via filesystem flag');
        emit({ type: 'paused', reason: 'manual' });
      }
      // Periodically re-check the filesystem flag even when paused in-memory.
      // If the flag was removed externally (e.g. resume IPC), auto-resume.
      if (applyPaused && !checkPauseFlag() && pauseResumeTime === null) {
        log('Pause flag removed — auto-resuming');
        applyPaused = false;
        consecutiveCaptchas = 0;
        emit({ type: 'resumed' });
        continue;
      }
      if (pauseResumeTime != null && Date.now() >= pauseResumeTime) {
        log('Captcha wall cooldown elapsed — resuming apply');
        applyPaused = false;
        consecutiveCaptchas = 0;
        removePauseFlag();
        emit({ type: 'resumed' });
        continue;
      }
      await sleep(1000);
      continue;
    }

    // ── Ensure contactor is connected ────────────────────────
    if (!contactor || !contactor.browser || !contactor.browser.isConnected()) {
      log(`CDP check — contactor=${!!contactor} browser=${!!contactor?.browser} connected=${!!contactor?.browser?.isConnected?.()}`);
      if (contactor) {
        try {
          await contactor.connect();
          cdpFailCount = 0;
          log('CDP reconnected');
        } catch (err) {
          cdpFailCount++;
          const isFatal = err.message.includes('CDP_FAILED') || err.message.includes('ECONNREFUSED');
          log(`CDP reconnect failed (#${cdpFailCount}): ${err.message}${isFatal ? ' [chrome dead]' : ''}`);
          if (isFatal) {
            log('*** Chrome unreachable — stopping daemon ***');
            emit({ type: 'chrome_dead', detail: err.message });
            process.exit(0);
          }
          await sleep(5000);
          continue;
        }
      } else {
        // Contactor was nulled (e.g. CDP died mid-apply). Try to re-create it.
        try {
          contactor = new IS24Contactor(
            CDP_URL,
            currentConfig.persona || {},
            currentConfig.timing?.speed || 'balanced',
            currentConfig.timing?.overrides || {},
            { api_key: currentConfig.captcha?.api_key || '' }
          );
          await contactor.connect();
          cdpFailCount = 0;
          log('Contactor re-created and CDP reconnected');
        } catch (err) {
          const isFatal = err.message.includes('CDP_FAILED') || err.message.includes('ECONNREFUSED');
          log(`Contactor re-create failed: ${err.message}${isFatal ? ' [chrome dead]' : ''}`);
          if (isFatal) {
            log('*** Chrome unreachable — stopping daemon ***');
            emit({ type: 'chrome_dead', detail: err.message });
            process.exit(0);
          }
          contactor = null;
          await sleep(5000);
          continue;
        }
      }
    }

    // ── Gather pending listings (round‑robin across filters) ─
    const filters = db.getFilters().filter(f => f.enabled);
    if (filters.length === 0) {
      await sleep(5000);
      continue;
    }

    let didWork = false;
    for (const filter of filters) {
      if (applyPaused || checkPauseFlag()) break;
      if (!filterIsStillEnabled(db, filter.id)) {
        log(`Apply skipped — filter paused/disabled: ${filter.name || filter.id}`);
        continue;
      }

      const queue = db.getSeenListings(filter.id);
      if (queue.length === 0) continue;

      // Check captcha wall before each listing
      if (consecutiveCaptchas >= 5) {
        log('Captcha wall detected — pausing apply for 15 minutes');
        applyPaused = true;
        pauseResumeTime = Date.now() + 15 * 60 * 1000;
        writePauseFlag('captcha_wall');
        emit({ type: 'captcha_wall', consecutive: consecutiveCaptchas });
        emit({ type: 'paused', reason: 'captcha_wall', resume_in_sec: 900 });
        break;
      }

      const listing = queue[0];
      if (applyPaused || checkPauseFlag() || !filterIsStillEnabled(db, filter.id)) {
        log(`Apply skipped before send — filter paused/disabled: ${filter.name || filter.id}`);
        continue;
      }
      // Check CDP alive before every listing — catches Cmd+Q instantly
      if (!contactor || !contactor.browser || !contactor.browser.isConnected()) {
        log('CDP disconnected — breaking filter loop');
        break;
      }
      log(`Applying to ${listing.expose_id} — ${(listing.title || '').slice(0, 60)}`);
      await applyOne(listing, filter.id, db);
      didWork = true;

      // If CDP died inside applyOne (contactor nulled), break the filter
      // loop so ensureCDPHealthy can handle it at the top of the next iteration.
      if (!contactor) {
        log('Contactor lost during apply — breaking filter loop');
        break;
      }

      if (!applyPaused) await jitter(2000, 5000);
    }

    if (!didWork) await sleep(5000);
  }
}

// ── Poll loop ──────────────────────────────────────────────────

async function pollLoop(db) {
  log('Poll loop started');

  // Emit an immediate heartbeat so the UI countdown appears right away
  const nextPollAt = resetNextPollDue();
  emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: nextPollAt });

  while (true) {
    // ── Detect wake from sleep ────────────────────────────────
    if (Date.now() - lastTick > (pollIntervalSec * 3000)) {
      log(`Time jump detected (${Math.round((Date.now() - lastTick) / 1000)}s) — poll cycle resuming after suspend`);
    }
    lastTick = Date.now();
    const cycleStart = Date.now();

    // ── Poll all enabled filters ─────────────────────────────
    log('Polling for new listings...');
    const filters = db.getFilters().filter(f => f.enabled);

    let totalNew = 0;
    for (const filter of filters) {
      if (!filterIsStillEnabled(db, filter.id)) {
        log(`Poll skipped — filter paused/disabled: ${filter.name || filter.id}`);
        continue;
      }
      try {
        const MAX_PAGES = 5, PAGE_SIZE = 20;
        let filterNew = 0, filterFetched = 0;
        for (let page = 1; page <= MAX_PAGES; page++) {
          if (!filterIsStillEnabled(db, filter.id)) {
            log(`Poll stopped — filter paused/disabled: ${filter.name || filter.id}`);
            break;
          }
          const { listings, error } = await fetchListings(filter.web_url, page);
          if (error) {
            if (page === 1) {
              log(`Poll error [${filter.id}]: ${error}`);
              emit({ type: 'poll_error', filter_id: filter.id, error });
            }
            break;
          }
          filterFetched += listings.length;
          const inserted = db.insertListings(listings, filter.id);
          filterNew += inserted;
          if (listings.length < PAGE_SIZE) break;
          if (inserted === 0) break;
        }

        if (filterNew > 0) {
          log(`  ${filter.name || filter.id}: ${filterNew} new listings (${filterFetched} fetched across pages)`);
          totalNew += filterNew;
        }

        if (filterIsStillEnabled(db, filter.id)) {
          db.updateFilter(filter.id, {
            last_polled_at: new Date().toISOString(),
            total_seen: (filter.total_seen || 0) + filterNew,
          });
        }
      } catch (err) {
        log(`Poll error [${filter.id}]: ${err.message}`);
        emit({ type: 'poll_error', filter_id: filter.id, error: err.message });
      }
    }

    log(`Poll complete — ${totalNew} new listings across ${filters.length} filters`);

    // ── Emit stats with next_poll_at based on poll schedule ──
    const elapsed = Date.now() - cycleStart;
    const delayMs = Math.max(0, (pollIntervalSec * 1000) - elapsed);
    nextPollDueAt = Date.now() + delayMs;
    const nextPollAt = new Date(nextPollDueAt).toISOString();
    emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: nextPollAt });

    // ── Sleep until next scheduled poll; settings/manual poll may reset deadline ──
    await sleepUntilNextPoll();
  }
}

// ── IPC message handler (from Electron parent) ──────────────────

function setupIpc(db) {
  process.on('message', async (msg) => {
    if (!msg) return;

    // ── Manual poll-now for a specific filter ────────────────
    if (msg.type === 'poll_now' && msg.filterId) {
      try {
        const filter = db.getFilter(msg.filterId);
        if (!filter) { log(`Poll-now: filter ${msg.filterId} not found`); return; }
        if (!filter.enabled) { log(`Poll-now skipped — filter paused/disabled: ${filter.name || filter.id}`); return; }
        log(`Manual poll for: ${filter.name || filter.id}`);

        const MAX_PAGES = 5, PAGE_SIZE = 20;
        let allInserted = 0, allFetched = 0;
        for (let page = 1; page <= MAX_PAGES; page++) {
          const { listings, error } = await fetchListings(filter.web_url, page);
          if (error) {
            if (page === 1) {
              log(`Poll-now error [${filter.id}]: ${error}`);
              emit({ type: 'poll_error', filter_id: filter.id, error });
            }
            break;
          }
          allFetched += listings.length;
          const inserted = db.insertListings(listings, filter.id);
          allInserted += inserted;
          if (listings.length < PAGE_SIZE) break;
          if (inserted === 0) break;
        }
        if (allInserted > 0) log(`  ${filter.name || filter.id}: ${allInserted} new listings (${allFetched} fetched across pages)`);
        db.updateFilter(filter.id, {
          last_polled_at: new Date().toISOString(),
          total_seen: (filter.total_seen || 0) + allInserted,
        });
        const nextPollAt = resetNextPollDue();
        emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: nextPollAt });
        if (allInserted > 0) {
          emit({ type: 'poll_complete', filter_id: filter.id, inserted: allInserted });
        }
      } catch (err) {
        log(`Poll-now error [${msg.filterId}]: ${err.message}`);
        emit({ type: 'poll_error', filter_id: msg.filterId, error: err.message });
      }
    }

    // ── Reset automatic all-search poll deadline ─────────────
    if (msg.type === 'reset_poll_schedule') {
      const nextPollAt = resetNextPollDue();
      log(`Poll schedule reset (${msg.reason || 'manual'}): next poll at ${nextPollAt}`);
      emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: nextPollAt });
      return;
    }

    // ── Retry a failed listing ───────────────────────────────
    if (msg.type === 'retry_listing' && msg.exposeId) {
      const result = db.retryListing(msg.exposeId);
      if (result.error) {
        log(`Retry: ${result.error} for expose ${msg.exposeId}`);
        emit({ type: 'retry_error', exposeId: msg.exposeId, error: result.error });
      } else if (result.already_seen) {
        log(`Retry: expose ${msg.exposeId} already in queue`);
      } else {
        log(`Retry: expose ${msg.exposeId} reset to seen`);
        emit({ type: 'retry_queued', exposeId: msg.exposeId, hash: result.hash });
        const nextPollAt = resetNextPollDue();
        emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: nextPollAt });
      }
    }

    // ── Pause applying (polling continues) ───────────────────
    if (msg.type === 'pause_apply') {
      log('Apply paused by user');
      applyPaused = true;
      pauseResumeTime = null;
      writePauseFlag();
      emit({ type: 'paused', reason: 'manual' });
    }

    // ── Resume applying ──────────────────────────────────────
    if (msg.type === 'resume_apply') {
      log('Apply resumed by user');
      applyPaused = false;
      consecutiveCaptchas = 0;
      removePauseFlag();
      emit({ type: 'resumed' });
    }

    // ── Config update (hot-reload all fields, no restart needed) ──
    if (msg.type === 'config_update') {
      let changed = false;
      if (msg.message_template !== undefined) {
        currentConfig.message_template = msg.message_template;
        log('Config hot-reload: message template updated');
        changed = true;
      }
      if (msg.captcha) {
        if (!currentConfig.captcha) currentConfig.captcha = {};
        mergePatch(currentConfig.captcha, msg.captcha);
        if (contactor) contactor.updateCaptcha(currentConfig.captcha);
        log('Config hot-reload: captcha config updated');
        changed = true;
      }
      if (msg.browser) {
        if (!currentConfig.browser) currentConfig.browser = {};
        mergePatch(currentConfig.browser, msg.browser);
        const maxTabs = Math.min(5, Math.max(1, Number(currentConfig.browser.max_tabs || 5)));
        currentConfig.browser.max_tabs = maxTabs;
        log(`Config hot-reload: browser config updated (max_tabs=${maxTabs})`);
        changed = true;
      }
      if (msg.poll_interval !== undefined) {
        pollIntervalSec = msg.poll_interval;
        log(`Config hot-reload: poll interval → ${pollIntervalSec}s`);
        const nextPollAt = resetNextPollDue();
        emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: nextPollAt });
        changed = true;
      }
      if (msg.persona) {
        currentConfig.persona = msg.persona;
        if (contactor) contactor.updateContact(msg.persona);
        log('Config hot-reload: persona updated');
        changed = true;
      }
      if (msg.timing) {
        currentConfig.timing = msg.timing;
        if (contactor) contactor.updateTiming(msg.timing.speed || 'balanced', msg.timing.overrides || {});
        log('Config hot-reload: timing updated');
        changed = true;
      }
      if (changed) {
        emit({ type: 'config_applied' });
      }
    }
  });
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  log('Homelander daemon starting...');

  // Ensure data directory exists
  const dataDir = dirname(DB_PATH);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // Set debug output directory
  const debugDir = join(dataDir, 'debug');
  if (!existsSync(debugDir)) mkdirSync(debugDir, { recursive: true });
  process.env.HOMELANDER_DEBUG_DIR = debugDir;

  // Load config
  currentConfig = loadConfig();
  log(`Config loaded: ${currentConfig.persona?.email || 'unknown'}, speed=${currentConfig.timing?.speed || 'balanced'}`);

  // Open database
  const db = new HomelanderDB(DB_PATH);
  log('Database opened');

  // Connect to Chrome
  try {
    contactor = new IS24Contactor(
      CDP_URL,
      currentConfig.persona || {},
      currentConfig.timing?.speed || 'balanced',
      currentConfig.timing?.overrides || {},
      { api_key: currentConfig.captcha?.api_key || '' }
    );
    await contactor.connect();
    log('Chrome CDP connected');
  } catch (err) {
    log(`Chrome CDP connection failed: ${err.message}`);
    emit({ type: 'error', message: `Chrome unavailable: ${err.message}` });
    contactor = null;
  }

  // Set up IPC from Electron parent
  setupIpc(db);

  // ── Check for persisted pause flag ─────────────────────────
  if (checkPauseFlag()) {
    applyPaused = true;
    pauseResumeTime = null;
    log('Starting in paused state (pause flag found on disk)');
    emit({ type: 'paused', reason: 'manual' });
  }

  // ── Start both independent loops ───────────────────────────
  log('Starting poll + apply loops...');
  await Promise.all([
    pollLoop(db),
    applyLoop(db),
  ]);

  // If we get here, it was a graceful shutdown (pendingRestart or manual stop)
  log('Both loops exited — daemon shutting down cleanly');
}

// ── Startup ────────────────────────────────────────────────────

// Prevent unhandled promise rejections from crashing the daemon
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason?.message || reason}`);
});

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  emit({ type: 'error', message: `Daemon crashed: ${err.message}` });
  process.exit(1);
});

// Forceful shutdown (user clicked Stop)
process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down');
  process.exit(0);
});
process.on('SIGINT', () => {
  log('SIGINT received — shutting down');
  process.exit(0);
});
