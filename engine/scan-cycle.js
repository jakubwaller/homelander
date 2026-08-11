// Scan-mode post-processing shared by the desktop daemon and the headless
// scanner (Docker deployment): enrich scanned listings with exposé details
// and coordinates, export everything to scan-listings.json, and send the
// weekly e-mail report when due.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchIs24ExposeDetails, geocodePostcode } from './sources.js';
import { maybeSendWeeklyReport } from './report.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a scan cycle bound to a logger. Keeps a per-process set of
 * already-attempted enrichments so failing listings don't retry forever.
 */
export function createScanCycle({ log = () => {} } = {}) {
  const attempted = new Set();

  async function enrich(db, limit = 8) {
    const candidates = db.getScanListingsNeedingEnrichment(limit * 4)
      .filter(row => !attempted.has(row.hash))
      .slice(0, limit);
    let enriched = 0;
    for (const row of candidates) {
      attempted.add(row.hash);
      try {
        let { lat, lng } = row;
        let scanJson;
        if (row.source === 'is24' && !row.scan_json) {
          const detail = await fetchIs24ExposeDetails(row.expose_id);
          if (!detail.error) {
            scanJson = JSON.stringify(detail.details || {});
            if (detail.lat != null) ({ lat, lng } = detail);
          }
          await sleep(500); // be gentle with the exposé endpoint
        }
        if (lat == null && row.postcode) {
          const geo = await geocodePostcode(row.postcode, db);
          if (geo) ({ lat, lng } = geo);
        }
        const update = db.updateListingScanData(row.hash, { lat, lng, scan_json: scanJson });
        if (update.changes > 0) enriched++;
      } catch (err) {
        log(`[scan-cycle] enrich failed for ${row.expose_id}: ${err?.message || err}`);
      }
    }
    return enriched;
  }

  function exportListings(db, dataDir) {
    if (db.getScanFilters().length === 0) return 0;
    const listings = db.getScanListings({ limit: 5000 }).map((l) => {
      let details = null;
      try { details = l.scan_json ? JSON.parse(l.scan_json) : null; } catch { /* keep null */ }
      const { scan_json, ...rest } = l;
      return { ...rest, details };
    });
    writeFileSync(join(dataDir, 'scan-listings.json'), JSON.stringify({
      generated_at: new Date().toISOString(),
      count: listings.length,
      listings,
    }, null, 2), 'utf8');
    return listings.length;
  }

  /**
   * Run one full cycle. Returns { enriched, exported } — never throws.
   * `onExported` is called with the export count (used by the daemon to
   * emit a scan_updated event).
   */
  async function run(db, config, dataDir, { onExported } = {}) {
    if (db.getScanFilters().length === 0) return { enriched: 0, exported: 0 };
    let enriched = 0, exported = 0;
    try {
      enriched = await enrich(db);
      if (enriched > 0) log(`Scan enrichment: ${enriched} listing(s) updated`);
    } catch (err) {
      log(`[scan-cycle] enrichment cycle failed: ${err?.message || err}`);
    }
    try {
      exported = exportListings(db, dataDir);
      if (onExported) onExported(exported);
    } catch (err) {
      log(`[scan-cycle] export failed: ${err?.message || err}`);
    }
    try {
      await maybeSendWeeklyReport(db, config, dataDir, { log });
    } catch (err) {
      log(`[scan-cycle] weekly report failed: ${err?.message || err}`);
    }
    return { enriched, exported };
  }

  return { enrich, exportListings, run };
}
