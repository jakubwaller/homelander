// Transit-line overlay data for the Kaufradar map.
//
// Fetches U-/S-Bahn route relations around Hamburg from Overpass once and
// caches them in <data dir>/transit-lines.json (refreshed when the file is
// older than 30 days). The Kaufradar serves the cache via /api/scan/transit;
// a failed fetch just means the map has no lines until the next attempt.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TRANSIT_FILE = 'transit-lines.json';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Hamburg + Umland: S-Bahn reaches Stade and Aumühle, U1 ends in Norderstedt.
const BBOX = '53.25,9.35,53.95,10.45';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// S-Bahn tagging varies (light_rail vs train), so match both and keep the
// train side pinned to S-refs; subway covers the U-Bahn.
const QUERY = `[out:json][timeout:60];
(
  relation["route"="subway"](${BBOX});
  relation["route"="light_rail"](${BBOX});
  relation["route"="train"]["ref"~"^S[0-9]"](${BBOX});
);
out geom;`;

export function transitFilePath(dataDir) {
  return join(dataDir, TRANSIT_FILE);
}

export function readTransitLines(dataDir) {
  try {
    return JSON.parse(readFileSync(transitFilePath(dataDir), 'utf8'));
  } catch {
    return { generated_at: null, lines: [] };
  }
}

/**
 * Group route relations by ref (a line has one relation per direction),
 * dedupe member ways, and round coordinates — 1e-5° is ~1 m, plenty for a
 * map overlay and it halves the JSON size.
 */
export function toLines(elements) {
  const byRef = new Map();
  for (const rel of elements || []) {
    const tags = rel.tags || {};
    const ref = tags.ref || '';
    if (!ref) continue;
    let line = byRef.get(ref);
    if (!line) {
      line = { ref, colour: tags.colour || '#666666', wayIds: new Set(), ways: [] };
      byRef.set(ref, line);
    }
    for (const m of rel.members || []) {
      if (m.type !== 'way' || !Array.isArray(m.geometry) || m.geometry.length < 2) continue;
      if (line.wayIds.has(m.ref)) continue;
      line.wayIds.add(m.ref);
      line.ways.push(m.geometry.map(p => [
        Math.round(p.lat * 1e5) / 1e5,
        Math.round(p.lon * 1e5) / 1e5,
      ]));
    }
  }
  return [...byRef.values()]
    .filter(l => l.ways.length)
    .sort((a, b) => a.ref.localeCompare(b.ref, 'de', { numeric: true }))
    .map(({ wayIds, ...rest }) => rest);
}

/** Fetch + cache transit lines if the cache is missing or stale. Never throws. */
export async function ensureTransitLines(dataDir, { log = () => {} } = {}) {
  const path = transitFilePath(dataDir);
  try {
    if (existsSync(path) && Date.now() - statSync(path).mtimeMs < MAX_AGE_MS) return;
  } catch { /* unreadable -> refetch */ }
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          // overpass-api.de 406s the bare node fetch UA.
          'User-Agent': 'homelander-kaufradar/1.0 (+https://github.com/jakubwaller/homelander)',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'data=' + encodeURIComponent(QUERY),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      // Overpass reports runtime errors as remarks on an HTTP 200.
      if (data.remark && /error/i.test(data.remark)) throw new Error(data.remark);
      const lines = toLines(data.elements);
      if (!lines.length) throw new Error('no route relations in reply');
      writeFileSync(path, JSON.stringify({ generated_at: new Date().toISOString(), lines }));
      log(`Transit lines cached: ${lines.length} route(s), ${Math.round(statSync(path).size / 1024)} kB`);
      return;
    } catch (err) {
      log(`WARN: transit line fetch failed (${endpoint}): ${err.message}`);
    }
  }
}
