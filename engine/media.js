// Listing media archive for the Kaufradar.
//
// Portals delete listings (and their pictures) once a property is sold; the
// radar keeps them. Each scan cycle downloads photos + floor plans for a few
// listings into <data dir>/media/<hash>/, with a media.json manifest per
// listing that the Kaufradar serves via /api/scan/media/<hash>.
//
// IS24 media URLs come from the exposé MEDIA section (stored in scan_json by
// enrichment; fetched directly here for listings enriched before that field
// existed). Kleinanzeigen/Neubaukompass only expose the list thumbnail — that
// one image is saved.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchIs24ExposeDetails } from './sources.js';

const MAX_PICTURES = 15; // per listing; floor plans are always kept
const FILE_DELAY_MS = 250;
const IS24_DELAY_MS = 500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extFor(url, contentType) {
  if (/webp/i.test(contentType)) return '.webp';
  if (/png/i.test(contentType)) return '.png';
  if (/jpe?g/i.test(contentType)) return '.jpg';
  const m = String(url).match(/\.(webp|png|jpe?g)(\/|$)/i);
  return m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
}

async function download(url, destBase) {
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const ext = extFor(url, resp.headers.get('content-type') || '');
  const file = destBase + ext;
  writeFileSync(file, Buffer.from(await resp.arrayBuffer()));
  return file;
}

/** Media entries for one listing row: [{url, caption, floorplan}]. */
async function mediaEntries(row) {
  let details = null;
  try { details = row.scan_json ? JSON.parse(row.scan_json) : null; } catch { /* refetch */ }
  if (row.source === 'is24') {
    if (!Array.isArray(details?.media)) {
      const detail = await fetchIs24ExposeDetails(row.expose_id);
      await sleep(IS24_DELAY_MS);
      if (detail.error) throw new Error(detail.error);
      details = detail.details;
    }
    return Array.isArray(details?.media) ? details.media : [];
  }
  return row.image_url ? [{ url: row.image_url, caption: '', floorplan: false }] : [];
}

/**
 * Download media for up to `limit` scan listings that have none yet.
 * A media.json manifest marks a listing as done (even when it yielded zero
 * files, so dead listings aren't retried forever). Never throws.
 */
export async function downloadMediaBatch(db, dataDir, { limit = 6, log = () => {} } = {}) {
  const mediaRoot = join(dataDir, 'media');
  const rows = db.db.prepare(`
    SELECT l.hash, l.expose_id, l.source, l.image_url, l.scan_json
    FROM listings l JOIN filters f ON f.id = l.filter_id
    WHERE f.mode = 'scan' AND (l.scan_json IS NOT NULL OR l.image_url != '')
    ORDER BY l.discovered_at DESC LIMIT 400
  `).all().filter(r => !existsSync(join(mediaRoot, r.hash, 'media.json'))).slice(0, limit);

  let saved = 0;
  for (const row of rows) {
    const dir = join(mediaRoot, row.hash);
    try {
      const entries = await mediaEntries(row);
      const pictures = entries.filter(e => !e.floorplan).slice(0, MAX_PICTURES);
      const plans = entries.filter(e => e.floorplan);
      mkdirSync(dir, { recursive: true });
      const manifest = [];
      let n = 0;
      for (const e of [...plans, ...pictures]) {
        n++;
        const base = e.floorplan
          ? `grundriss-${String(n).padStart(2, '0')}`
          : String(n).padStart(2, '0');
        try {
          const file = await download(e.url, join(dir, base));
          manifest.push({ file: file.split('/').pop(), caption: e.caption || '', floorplan: !!e.floorplan });
          saved++;
        } catch (err) {
          log(`[media] ${row.expose_id}: ${err.message} (${e.url.slice(0, 80)})`);
        }
        await sleep(FILE_DELAY_MS);
      }
      writeFileSync(join(dir, 'media.json'), JSON.stringify({
        saved_at: new Date().toISOString(),
        files: manifest,
      }));
    } catch (err) {
      log(`[media] skipping ${row.expose_id}: ${err.message}`);
    }
  }
  return saved;
}
