#!/usr/bin/env node
// Autoapply — polls Fredy for new IS24 listings and auto-sends contact
// messages via host Chrome CDP.  Designed to run as a cron job (every 60s).

import { join, dirname } from 'node:path';
import { appendFileSync, mkdirSync, existsSync, copyFileSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import { FredyClient } from './fredy-client.js';
import { IS24Contactor } from './is24-contactor.js';
import { StateManager } from './state-manager.js';

// Force unbuffered stdout for background/cron runs
process.stdout._handle?.setBlocking?.(true);

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = process.env.AUTOAPPLY_RUNTIME_DIR || join(__dirname, '..', 'runtime');
const DEBUG_DIR = join(__dirname, '..', 'debug');
const LOGS_DIR = join(DEBUG_DIR, 'logs');
const RUNS_DIR = join(LOGS_DIR, 'runs');
const BACKUPS_DIR = join(LOGS_DIR, 'backups');
const STATE_FILE = join(RUNTIME_DIR, 'state.json');
const RESULTS_FILE = join(RUNTIME_DIR, 'results.jsonl');

// ── Logging helpers ──────────────────────────────────────────────────

/** Current run identifier — set once at startup. */
let RUN_ID = '';

/** ISO timestamp prefix for console lines. */
function ts() {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

/** Console log with timestamp prefix. */
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

/** Sleep for ms milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random jitter between min and max ms. */
function jitter(min, max) {
  return sleep(min + Math.random() * (max - min));
}

/** Tag a listing with type hints for analysis. */
function classifyListing(title) {
  const tags = [];
  if (/Tauschwohnung/i.test(title)) tags.push('tausch');
  if (/Wentzel/i.test(title)) tags.push('wentzel');
  if (/Zwischenmiete/i.test(title)) tags.push('zwischenmiete');
  return tags.length ? tags : ['regular'];
}

/** Append one JSON line to the results file. */
function logResult(obj) {
  try {
    if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true });
    appendFileSync(RESULTS_FILE, JSON.stringify(obj) + '\n', 'utf8');
  } catch {}
}

/** Simple config fingerprint for run identification. */
function configFingerprint(cfg) {
  const keyParts = [
    cfg.contact?.email || '?',
    cfg.contact?.vorname || '',
    cfg.contact?.nachname || '',
    cfg.speed || 'balanced',
  ];
  const hash = createHash('sha256').update(keyParts.join('|')).digest('hex').slice(0, 8);
  return { hash, email: cfg.contact?.email || '?', speed: cfg.speed || 'balanced' };
}

/** Get Node/Chrome version info. */
function getEnvironment() {
  const env = { node: process.version, platform: `${process.platform} ${process.arch}` };
  return env;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  const watchMode = process.argv.includes('--watch');
  const tStart = new Date();

  // Run ID: timestamp + config hash
  const fp = configFingerprint(cfg);
  RUN_ID = `${tStart.toISOString().replace(/[-:T]/g, '').slice(0, 15)}_${fp.hash}`;
  const runLogPath = join(RUNS_DIR, `run_${RUN_ID}.log`);

  // Tee console output to a per-run log file
  let logStream;
  try {
    logStream = createWriteStream(runLogPath, { flags: 'w' });
    const origLog = console.log;
    console.log = (...args) => {
      const line = args.join(' ');
      origLog(line);
      try { logStream.write(line + '\n'); } catch {}
    };
    const origErr = console.error;
    console.error = (...args) => {
      const line = args.join(' ');
      origErr(line);
      try { logStream.write(line + '\n'); } catch {}
    };
  } catch {}

  log(`── Run ${RUN_ID} ──`);
  log(`Persona: ${fp.email} | Speed: ${fp.speed}`);
  log(`Node: ${getEnvironment().node} | Platform: ${getEnvironment().platform}`);

  if (cfg.dryRun) {
    log('DRY_RUN mode — will detect listings but NOT send any messages.');
  }

  // ── 1. Auth with Fredy (once) ────────────────────────────────────
  const fredy = new FredyClient(cfg.fredyBaseUrl, cfg.fredyUsername, cfg.fredyPassword);
  try {
    await fredy.login();
    log(`Connected to Fredy at ${cfg.fredyBaseUrl}`);
  } catch (err) {
    console.error(`[${ts()}] AUTH_FAILED — ${err.message}`);
    process.exit(1);
  }

  // ── 2. Run ticks ─────────────────────────────────────────────────
  const stateMgr = new StateManager(STATE_FILE);
  const interval = (cfg.polling?.interval_seconds || 60) * 1000;
  let tickNum = 0;

  do {
    tickNum++;
    if (tickNum > 1) log(`─── Tick ${tickNum} ───`);

    const tickStart = Date.now();

    try {
      await runTick({ cfg, fredy, stateMgr });
    } catch (err) {
      console.error(`[${ts()}] TICK_FAILED — ${err.message}`);
      if (!watchMode) process.exit(1);
    }

    if (watchMode) {
      const elapsed = Date.now() - tickStart;
      const wait = Math.max(0, interval - elapsed);
      if (wait > 0) {
        log(`Waiting ${Math.round(wait / 1000)}s until next poll...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  } while (watchMode);

  logStream?.end();
  process.exit(0);
}

async function runTick({ cfg, fredy, stateMgr }) {
  let listings;
  try {
    listings = await fredy.getListings(cfg.jobId);
  } catch (err) {
    console.error(`[${ts()}] FREDY_FAILED — ${err.message}`);
    throw err;
  }

  if (listings.length === 0) {
    log('No listings returned from Fredy.');
    return;
  }

  // ── 3. Diff against state ───────────────────────────────────────
  const state = stateMgr.load();
  const newListings = stateMgr.findNew(listings, state);

  if (newListings.length === 0) return;

  log(`Found ${newListings.length} new listing(s) out of ${listings.length} total.`);

  const cap = cfg.maxSendsPerRun || 0;
  const toSend = cap > 0 ? newListings.slice(0, cap) : newListings;
  log(`Cap: ${cap > 0 ? cap : 'unlimited'}, processing ${toSend.length} of ${newListings.length} new`);

  if (cfg.dryRun) {
    for (let i = 0; i < toSend.length; i++) {
      const listing = toSend[i];
      const exposeId = (listing.link || '').replace(/\/+$/, '').split('/').pop();
      log(`DRY_RUN | ${exposeId} | ${listing.title || '?'} | ${listing.price || '?'}€ | ${listing.address || '?'}`);
    }
    log(`Done: ${toSend.length} would be sent`);
    return;
  }

  // ── 4. Connect to host Chrome via CDP ────────────────────────────
  const speed = cfg.speed || 'balanced';
  const timingOverrides = cfg.timing || {};
  const contactor = new IS24Contactor(cfg.cdpUrl, cfg.contact || {}, speed, timingOverrides, cfg.captcha || {});
  const t = contactor.t;
  const [cdMin, cdMax] = t.cooldown;
  const [psMin, psMax] = t.preSendJitter;
  log(`Speed: ${speed} | Cooldown: ${cdMin / 1000}-${cdMax / 1000}s | Pre-send: ${psMin / 1000}-${psMax / 1000}s`);
  try {
    await contactor.connect();
    log(`Connected to Chrome at ${cfg.cdpUrl}`);
  } catch (err) {
    console.error(`[${ts()}] CDP_FAILED — ${err.message}`);
    throw err;
  }

  // ── 5. Send messages ────────────────────────────────────────────
  const tRunStart = Date.now();
  let sent = 0;
  let skipped = 0;
  let blocked = 0;
  let seq = 0;

  // Captcha tracking
  let captchaDetected = 0;
  let captchaSolved = 0;
  let captchaFailed = 0;
  let consecutiveCaptchas = 0;
  let maxConsecutiveCaptchas = 0;
  const breakdown = {}; // failureType → count

  const fullName = `${cfg.contact?.vorname || ''} ${cfg.contact?.nachname || ''}`.trim();

  try {
    for (let i = 0; i < toSend.length; i++) {
      seq++;
      const listing = toSend[i];
      const fredyId = listing.id;
      const exposeId = (listing.link || '').replace(/\/+$/, '').split('/').pop();
      const title = listing.title || '?';
      const price = listing.price || '?';
      const address = listing.address || '?';

      // Pre-send delay
      await jitter(psMin, psMax);

      // Personalize message
      const personalizedMessage = cfg.message
        ? cfg.message.replace(/\{\{title\}\}/g, title)
                     .replace(/\{\{address\}\}/g, address)
                     .replace(/\{\{name\}\}/g, fullName)
        : cfg.message;

      const result = await contactor.apply(exposeId, personalizedMessage || '', cfg.captcha?.api_key);

      // Captcha tracking
      const capDetected = result.captcha?.detected || false;
      const capSolved = result.captcha?.solved || false;
      if (capDetected) {
        captchaDetected++;
        consecutiveCaptchas++;
        if (consecutiveCaptchas > maxConsecutiveCaptchas) maxConsecutiveCaptchas = consecutiveCaptchas;
        if (capSolved) captchaSolved++;
        else captchaFailed++;
      } else {
        consecutiveCaptchas = 0;
      }

      // Wall warning
      if (consecutiveCaptchas === 5) {
        log(`⚠️  CAPTCHA WALL FORMING — ${consecutiveCaptchas} consecutive captchas (listing #${seq})`);
      } else if (consecutiveCaptchas > 5 && consecutiveCaptchas % 3 === 0) {
        log(`⚠️  CAPTCHA WALL — ${consecutiveCaptchas} consecutive captchas and counting (#${seq})`);
      }

      // Build console line
      const capEmoji = capDetected ? (capSolved ? '🔐' : '❌') : '✓';
      const capDetail = capDetected
        ? ` captcha:${result.captcha?.attempts || '?'}/${capSolved ? '✓' : '✗'}`
        + (capSolved && result.captcha?.solutions?.length ? ` "${result.captcha.solutions.slice(-1)[0]}"` : '')
        + (capSolved && result.captcha?.solve_ms ? ` (${Math.round(result.captcha.solve_ms / 100) / 10}s)` : '')
        : '';
      const timingStr = ` ${Math.round((result.timing_ms || 0) / 100) / 10}s`;
      const fieldStr = result.fields_typed ? ` ${result.fields_typed}f` : '';
      const retryStr = result.field_retries ? `/${result.field_retries}r` : '';

      if (result.success) {
        log(`#${seq} ${capEmoji} SENT | ${exposeId} | ${title} | ${price}€ | ${address} |${capDetail} |${fieldStr}${retryStr} |${timingStr} | ${result.detail || '✓'}`);
        stateMgr.markSent(state, fredyId);
        stateMgr.save(state);
        sent++;

        logResult({
          ts: new Date().toISOString(), run_id: RUN_ID, seq, exposeId, fredyId, title, price, address,
          message_text: personalizedMessage,
          tags: classifyListing(title),
          outcome: 'SENT', detail: result.detail,
          captcha: result.captcha,
          timing: result.timing,
          timing_ms: result.timing_ms,
          form_state: result.form_state,
          fields_typed: result.fields_typed || 0,
          field_retries: result.field_retries || 0,
        });
      } else {
        // Classify failure type
        let failureType = 'unknown';
        if (result.reason?.includes('captcha')) failureType = 'captcha';
        else if (result.reason?.includes('premium') || result.reason?.includes('PREMIUM')) failureType = 'premium';
        else if (result.reason?.includes('NO_FORM')) failureType = 'no_form';
        else if (result.reason?.includes('server error')) failureType = 'server_error';
        else if (result.reason?.includes('ERROR:')) failureType = 'error';
        else if (result.reason?.includes('no confirmation')) failureType = 'no_confirmation';
        else if (result.reason?.includes('validation')) failureType = 'validation';

        breakdown[failureType] = (breakdown[failureType] || 0) + 1;

        log(`#${seq} ${capEmoji} FAIL | ${exposeId} | ${title} | ${result.reason}${capDetail}${timingStr}`);

        logResult({
          ts: new Date().toISOString(), run_id: RUN_ID, seq, exposeId, fredyId, title, price, address,
          message_text: personalizedMessage,
          tags: classifyListing(title),
          outcome: 'FAIL', failureType, detail: result.reason,
          captcha: result.captcha,
          timing: result.timing,
          timing_ms: result.timing_ms,
          form_state: result.form_state,
          fields_typed: result.fields_typed || 0,
          field_retries: result.field_retries || 0,
        });

        if (result.reason?.startsWith('BLOCKED') ||
            (result.reason?.startsWith('SUBMIT_FAILED') && !result.reason?.includes('PREMIUM_ONLY'))) {
          blocked++;
        } else {
          stateMgr.markSeen(state, fredyId);
          stateMgr.save(state);
          skipped++;
        }
      }

      // Cooldown between sends
      if (i < toSend.length - 1) {
        log(`Cooldown (${Math.round(cdMin / 1000)}-${Math.round(cdMax / 1000)}s)...`);
        await jitter(cdMin, cdMax);
      }
    }
  } finally {
    await contactor.disconnect();
  }

  const tRunEnd = Date.now();
  const durationMin = Math.round((tRunEnd - tRunStart) / 6000) / 10;

  // ── Final summary ────────────────────────────────────────────────
  log('');
  log(`═══ RUN COMPLETE ═══`);
  log(`Duration: ${durationMin}min | ${sent} sent, ${skipped} skipped, ${blocked} blocked`);
  log(`Captcha: ${captchaDetected} detected, ${captchaSolved} solved, ${captchaFailed} failed (${captchaDetected > 0 ? Math.round(captchaSolved / captchaDetected * 100) : 0}% solve rate)`);
  log(`Max consecutive captchas: ${maxConsecutiveCaptchas}`);
  if (Object.keys(breakdown).length > 0) {
    log(`Failure breakdown: ${Object.entries(breakdown).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  logResult({
    ts: new Date().toISOString(),
    type: 'SUMMARY',
    run_id: RUN_ID,
    started: new Date(tRunStart).toISOString(),
    finished: new Date(tRunEnd).toISOString(),
    duration_minutes: durationMin,
    sent, skipped, blocked,
    total: toSend.length,
    breakdown,
    captcha_stats: {
      detected: captchaDetected,
      solved: captchaSolved,
      failed: captchaFailed,
      solve_rate: captchaDetected > 0 ? Math.round(captchaSolved / captchaDetected * 100) / 100 : 0,
      max_consecutive: maxConsecutiveCaptchas,
    },
    config: {
      speed: cfg.speed,
      cap: cfg.maxSendsPerRun || 0,
      email: cfg.contact?.email || '?',
      name: fullName,
      fingerprint: configFingerprint(cfg).hash,
    },
    environment: getEnvironment(),
  });

  // Timestamped backup
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  try { copyFileSync(RESULTS_FILE, join(BACKUPS_DIR, `results_${ts}.jsonl`)); } catch {}
  try { copyFileSync(STATE_FILE, join(BACKUPS_DIR, `state_${ts}.json`)); } catch {}
}

main().catch((err) => {
  console.error(`[${ts()}] FATAL: ${err.message}`);
  process.exit(1);
});
