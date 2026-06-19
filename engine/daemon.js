#!/usr/bin/env node
// Homelander Daemon — polls IS24 mobile API for new listings,
// then auto-applies to them via Chrome CDP. Runs continuously.
//
// Usage: node engine/daemon.js --db=<path> --cdp-url=<url> --config=<path>
//
// Communicates status via stdout JSON lines:
//   {"type":"stats","seen":142,"sent":23,"failed":8,"new":3,"today":5}
//   {"type":"listing","outcome":"SENT","exposeId":"123","title":"...","price":1200,"address":"...","detail":"..."}
//   {"type":"captcha_wall","consecutive":5}
//   {"type":"paused","reason":"captcha_wall","resume_in_sec":900}
//   {"type":"resumed"}
//   {"type":"error","message":"..."}
//   {"type":"poll_error","filter_id":"...","error":"..."}

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse CLI args
const { values: args } = parseArgs({
  options: {
    db: { type: 'string' },
    'cdp-url': { type: 'string', default: 'http://localhost:9222' },
    config: { type: 'string' },
    'poll-interval': { type: 'string', default: '120' }, // seconds, default 2 min
    'dry-run': { type: 'boolean', default: false },
  },
});

const DB_PATH = args.db || join(process.env.HOME || '/tmp', '.homelander', 'homelander.db');
const CDP_URL = args['cdp-url'];
const CONFIG_PATH = args.config;
const POLL_INTERVAL_SEC = parseInt(args['poll-interval'], 10);
const DRY_RUN = args['dry-run'];

// Dynamic imports
const { HomelanderDB } = await import('./db.js');
const { IS24Contactor } = await import('./is24-contactor.js');
const { fetchListings } = await import('./url-translator.js');

// ── Helpers ────────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${ts}] ${msg}\n`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

// ── Config loading ─────────────────────────────────────────────

function loadConfig() {
  if (!CONFIG_PATH || !existsSync(CONFIG_PATH)) {
    log('ERROR: config file not found at ' + CONFIG_PATH);
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

// ── Main loop ──────────────────────────────────────────────────

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
  const config = loadConfig();
  log(`Config loaded: ${config.persona?.email || 'unknown'}, speed=${config.timing?.speed || 'balanced'}`);

  // Open database
  const db = new HomelanderDB(DB_PATH);
  log('Database opened');

  // Connect to Chrome
  let contactor;
  try {
    contactor = new IS24Contactor(
      CDP_URL,
      config.persona || {},
      config.timing?.speed || 'balanced',
      config.timing?.overrides || {},
      { api_key: config.captcha?.api_key || '' }
    );
    await contactor.connect();
    log('Chrome CDP connected');
  } catch (err) {
    log(`Chrome CDP connection failed: ${err.message}`);
    emit({ type: 'error', message: `Chrome unavailable: ${err.message}` });
    // Continue — poller can still work, just can't apply
    contactor = null;
  }

  // Captcha wall tracking
  let consecutiveCaptchas = 0;
  let applyPaused = false;
  let pauseResumeTime = 0;

  // ── Manual poll-now handler (IPC from Electron) ──────────────
  process.on('message', async (msg) => {
    if (msg && msg.type === 'poll_now' && msg.filterId) {
      try {
        const filter = db.getFilter(msg.filterId);
        if (!filter) { log(`Poll-now: filter ${msg.filterId} not found`); return; }
        log(`Manual poll for: ${filter.name || filter.id}`);
        const { listings, error } = await fetchListings(filter.web_url);
        if (error) {
          log(`Poll-now error [${filter.id}]: ${error}`);
          emit({ type: 'poll_error', filter_id: filter.id, error });
          return;
        }
        const inserted = db.insertListings(listings, filter.id);
        if (inserted > 0) log(`  ${filter.name || filter.id}: ${inserted} new listings`);
        db.updateFilter(filter.id, {
          last_polled_at: new Date().toISOString(),
          total_seen: (filter.total_seen || 0) + inserted,
        });
        const stats = db.getTodayStats();
        emit({ type: 'stats', ...stats });
      } catch (err) {
        log(`Poll-now error [${msg.filterId}]: ${err.message}`);
        emit({ type: 'poll_error', filter_id: msg.filterId, error: err.message });
      }
    }
  });

  // ── Main daemon loop ─────────────────────────────────────────
  while (true) {
    const cycleStart = Date.now();

    // ── PHASE 1: Poll ──────────────────────────────────────────
    log('Polling for new listings...');
    const filters = db.getFilters().filter(f => f.enabled);

    let totalNew = 0;
    for (const filter of filters) {
      try {
        const { listings, error } = await fetchListings(filter.web_url);
        if (error) {
          log(`Poll error [${filter.id}]: ${error}`);
          emit({ type: 'poll_error', filter_id: filter.id, error });
          continue;
        }

        const inserted = db.insertListings(listings, filter.id);
        if (inserted > 0) {
          log(`  ${filter.name || filter.id}: ${inserted} new listings`);
          totalNew += inserted;
        }

        db.updateFilter(filter.id, {
          last_polled_at: new Date().toISOString(),
          total_seen: (filter.total_seen || 0) + inserted,
        });
      } catch (err) {
        log(`Poll error [${filter.id}]: ${err.message}`);
        emit({ type: 'poll_error', filter_id: filter.id, error: err.message });
      }
    }

    log(`Poll complete — ${totalNew} new listings across ${filters.length} filters`);

    // ── PHASE 2: Apply (round‑robin across filters) ──────────
    // Each filter gets its own queue of unapplied listings.
    // We pick one from each filter in turn — A, B, C, A, B, C…
    // so no single search starves the others.
    if (contactor && !applyPaused) {
      const filterIds = filters.map(f => f.id);
      const queues = {};
      let totalPending = 0;
      for (const fid of filterIds) {
        queues[fid] = db.getSeenListings(fid);
        totalPending += queues[fid].length;
      }

      if (totalPending > 0) {
        log(`Applying to ${totalPending} pending listings across ${filterIds.length} searches (round‑robin)...`);

        let globalIdx = 0;
        let anyLeft = true;
        while (anyLeft) {
          anyLeft = false;
          for (const fid of filterIds) {
            const queue = queues[fid];
            if (globalIdx >= queue.length) continue;
            anyLeft = true;

            const listing = queue[globalIdx];

            // Check if we should pause (captcha wall)
            if (consecutiveCaptchas >= 5) {
              log('Captcha wall detected — pausing apply for 15 minutes');
              applyPaused = true;
              pauseResumeTime = Date.now() + 15 * 60 * 1000;
              emit({ type: 'captcha_wall', consecutive: consecutiveCaptchas });
              emit({ type: 'paused', reason: 'captcha_wall', resume_in_sec: 900 });
              // Break out of both loops by forcing anyLeft false
              anyLeft = false;
              break;
            }

            try {
              const message = personaliseMessage(config.message_template, {
                ...listing,
                _contact: config.persona,
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
                  detail: 'dry run — not sent',
                });
                continue;
              }

              // Reconnect if needed
              if (!contactor.browser || !contactor.browser.isConnected()) {
                try {
                  await contactor.connect();
                  log('CDP reconnected');
                } catch (err) {
                  log(`CDP reconnect failed: ${err.message}`);
                  emit({ type: 'error', message: `Chrome reconnect failed: ${err.message}` });
                  contactor = null;
                  anyLeft = false;
                  break;
                }
              }

              const result = await contactor.apply(
                listing.expose_id,
                message,
                config.captcha?.api_key || ''
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
                  detail: result.detail || '',
                  failureReason,
                });
              } else {
                const reason = result.reason || '';
                const isDeactivated = reason.includes('DEACTIVATED');
                const failureReason = isDeactivated ? 'deactivated'
                  : reason.includes('captcha') ? 'captcha'
                  : reason.includes('PREMIUM') ? 'premium'
                  : reason.includes('NO_FORM') ? 'no_form'
                  : reason.includes('server_error') ? 'server_error'
                  : 'unknown';

                const outcome = isDeactivated ? 'DEACTIVATED' : 'FAIL';
                db.markSent(listing.hash, outcome, reason, failureReason);
                log(`  ${isDeactivated ? '◌' : '✗'} ${outcome} | ${listing.expose_id} | ${listing.title} | ${reason}`);

                if (failureReason === 'captcha') {
                  consecutiveCaptchas++;
                } else {
                  consecutiveCaptchas = 0;
                }

                emit({
                  type: 'listing',
                  outcome,
                  exposeId: listing.expose_id,
                  title: listing.title,
                  price: listing.price,
                  address: listing.address,
                  detail: reason,
                  failureReason,
                });
              }
            } catch (err) {
              log(`  ERROR | ${listing.expose_id} | ${err.message}`);
              db.markSent(listing.hash, 'FAIL', `ERROR: ${err.message}`, 'error');
              consecutiveCaptchas = 0;
              emit({
                type: 'listing',
                outcome: 'FAIL',
                exposeId: listing.expose_id,
                title: listing.title,
                price: listing.price,
                address: listing.address,
                detail: `ERROR: ${err.message}`,
              });
            }
          }
          globalIdx++;
          // Pause check at the end of each row (outer loop)
          if (applyPaused) break;
        }
      }
    } else if (applyPaused && Date.now() >= pauseResumeTime) {
      // Auto-resume after captcha wall cooldown
      log('Captcha wall cooldown elapsed — resuming apply');
      applyPaused = false;
      consecutiveCaptchas = 0;
      emit({ type: 'resumed' });
    }

    // ── PHASE 3: Stats (today only for the live dashboard) ────
    const stats = db.getTodayStats();
    const elapsed = Date.now() - cycleStart;
    const sleepMs = Math.max(0, (POLL_INTERVAL_SEC * 1000) - elapsed);
    const nextPollAt = new Date(Date.now() + sleepMs).toISOString();
    emit({
      type: 'stats',
      ...stats,
      next_poll_at: nextPollAt,
    });

    // ── PHASE 4: Sleep ─────────────────────────────────────────
    log(`Cycle complete. Sleeping ${Math.round(sleepMs / 1000)}s until next poll.`);
    await sleep(sleepMs);
  }
}

// ── Startup ────────────────────────────────────────────────────

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  emit({ type: 'error', message: `Daemon crashed: ${err.message}` });
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down');
  process.exit(0);
});
process.on('SIGINT', () => {
  log('SIGINT received — shutting down');
  process.exit(0);
});
