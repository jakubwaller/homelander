#!/usr/bin/env node
// Homelander headless scanner — Docker/server deployment.
//
// Runs the analysis-only ("scan") half of Homelander without Electron or
// Chromium: polls all scan-mode searches, enriches listings, writes
// scan-listings.json, serves the Kaufradar site, and sends the weekly
// e-mail report. Apply-mode searches are ignored entirely — this process
// can never send applications.
//
// Usage:
//   node engine/headless.js            # poll loop + Kaufradar server
//   node engine/headless.js --once     # single poll cycle, then exit
//
// Configuration (all optional):
//   HOMELANDER_DATA_DIR       data dir (default ~/.homelander); holds
//                             homelander.db, config.json, scan-listings.json
//   HOMELANDER_SCAN_URLS      comma/newline-separated search URLs to sync
//   HOMELANDER_SCAN_HOST      Kaufradar bind address (default 127.0.0.1;
//                             set 0.0.0.0 inside Docker)
//   HOMELANDER_SCAN_PORT      Kaufradar port (default 8477)
//   HOMELANDER_POLL_INTERVAL  poll interval in seconds (default 600)
//   <data dir>/scan-searches.json  — JSON array of "url" strings or
//                             { "url": "...", "name": "..." } objects
//   <data dir>/config.json    — same format as the desktop app; only the
//                             scan/polling/report sections are used here

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { HomelanderDB } from './db.js';
import { fetchAnyListings, validateAnySearchUrl } from './sources.js';
import { createScanCycle } from './scan-cycle.js';
import { startScanServer } from './scan-server.js';
import { ensureTransitLines } from './transit.js';

const DATA_DIR = process.env.HOMELANDER_DATA_DIR || join(homedir(), '.homelander');
const DB_PATH = join(DATA_DIR, 'homelander.db');

export function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    log(`WARN: could not parse ${path}: ${err.message}`);
    return null;
  }
}

/** Parse HOMELANDER_SCAN_URLS / scan-searches.json into { url, name } entries. */
export function parseSearchEntries({ env = '', fileContent = null } = {}) {
  const entries = [];
  for (const url of String(env || '').split(/[\n,]/).map(v => v.trim()).filter(Boolean)) {
    entries.push({ url, name: '' });
  }
  if (Array.isArray(fileContent)) {
    for (const item of fileContent) {
      if (typeof item === 'string' && item.trim()) entries.push({ url: item.trim(), name: '' });
      else if (item && typeof item.url === 'string' && item.url.trim()) {
        entries.push({ url: item.url.trim(), name: String(item.name || '') });
      }
    }
  }
  return entries;
}

/**
 * Ensure every configured search exists in the DB as a scan-mode filter.
 * The headless scanner is analysis-only, so even rent/apply URLs are
 * stored with mode='scan'. Existing filters (by web_url) are left alone.
 */
export function syncScanSearches(db, entries, { logFn = log } = {}) {
  const existing = new Set(
    db.db.prepare('SELECT web_url FROM filters WHERE archived = 0').all().map(r => r.web_url)
  );
  let added = 0;
  for (const { url, name } of entries) {
    if (existing.has(url)) continue;
    const validation = validateAnySearchUrl(url);
    if (!validation.ok) {
      logFn(`WARN: skipping invalid search URL (${validation.error}): ${url}`);
      continue;
    }
    if (validation.mode !== 'scan') {
      logFn(`NOTE: ${url} is a rent/apply search — added as scan-only (headless never applies)`);
    }
    db.addFilter({
      id: randomUUID(),
      name: name || validation.preview?.location || '',
      web_url: url,
      mobile_params: validation.mobileUrl || '',
      mode: 'scan',
      source: validation.source || 'is24',
    });
    existing.add(url);
    added++;
    logFn(`Added scan search: ${name || url}`);
  }
  return added;
}

async function pollScanFilters(db, config) {
  const filters = db.getScanFilters().filter(f => f.enabled);
  let totalNew = 0;
  for (const filter of filters) {
    try {
      const MAX_PAGES = 10, PAGE_SIZE = 20;
      let filterNew = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { listings, error } = await fetchAnyListings(filter.web_url, page);
        if (error) {
          if (page === 1) log(`Poll error [${filter.name || filter.id}]: ${error}`);
          break;
        }
        const deduped = listings.filter(l => !db.isManuallyApplied(l.expose_id));
        const inserted = db.insertListings(deduped, filter.id);
        filterNew += inserted;
        if (listings.length < PAGE_SIZE) break;
        if (inserted === 0) break;
      }
      db.incrementFilterSeen(filter.id, filterNew);
      if (filterNew > 0) log(`  ${filter.name || filter.id}: ${filterNew} new listing(s)`);
      totalNew += filterNew;
    } catch (err) {
      log(`Poll error [${filter.name || filter.id}]: ${err.message}`);
    }
  }
  log(`Poll complete — ${totalNew} new listing(s) across ${filters.length} scan search(es)`);
  return totalNew;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const once = process.argv.includes('--once');
  log(`Homelander headless scanner starting (data dir: ${DATA_DIR})`);

  const config = readJsonFile(join(DATA_DIR, 'config.json')) || {};
  const db = new HomelanderDB(DB_PATH);
  const scanCycle = createScanCycle({ log });

  const entries = parseSearchEntries({
    env: process.env.HOMELANDER_SCAN_URLS,
    fileContent: readJsonFile(join(DATA_DIR, 'scan-searches.json')),
  });
  syncScanSearches(db, entries);

  const scanFilters = db.getScanFilters();
  if (scanFilters.length === 0) {
    log('No scan searches configured yet — add URLs via HOMELANDER_SCAN_URLS or scan-searches.json');
  } else {
    log(`${scanFilters.length} scan search(es) active`);
  }

  let server = null;
  if (!once) {
    const host = process.env.HOMELANDER_SCAN_HOST || config.scan?.host || '127.0.0.1';
    const port = Number(process.env.HOMELANDER_SCAN_PORT) || config.scan?.port || 8477;
    server = await startScanServer(() => db, { host, port, dataDir: DATA_DIR });
    log(`Kaufradar running at ${server.url}`);
    void ensureTransitLines(DATA_DIR, { log });
  }

  const intervalSec = Number(process.env.HOMELANDER_POLL_INTERVAL)
    || config.polling?.interval_seconds || 600;

  let running = true;
  const shutdown = async (signal) => {
    if (!running) return;
    running = false;
    log(`${signal} received — shutting down`);
    try { await server?.close(); } catch { /* best-effort */ }
    try { db.close(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  while (running) {
    await pollScanFilters(db, config);
    await scanCycle.run(db, config, DATA_DIR);
    // Cheap no-op while the cache is fresh; retries a failed Overpass fetch
    // on the next cycle instead of waiting for a container restart.
    if (!once) await ensureTransitLines(DATA_DIR, { log });
    if (once) break;
    await sleep(intervalSec * 1000);
  }

  if (once) {
    db.close();
    log('Single cycle done — exiting');
  }
}

// Only run when executed directly (the exports above are unit-tested).
const invokedDirectly = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  process.on('unhandledRejection', (reason) => {
    log(`Unhandled rejection: ${reason?.message || reason}`);
  });
  main().catch((err) => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
