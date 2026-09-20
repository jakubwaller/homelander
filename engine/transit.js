// Transit data for the Kaufradar: line geometry for the map overlay and
// station coordinates for the weekly report's walking-distance filter.
//
// Fetches U-/S-Bahn route relations around Hamburg from Overpass once and
// caches them in <data dir>/transit-lines.json (refreshed when the file is
// older than 30 days). The Kaufradar serves the lines via /api/scan/transit;
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
//
// Stations come from the same relations rather than a standalone
// `railway=station` query: the named member nodes of a route are exactly the
// stops that route serves, so the report can never rank a flat as well
// connected via a station no U-/S-Bahn actually calls at.
const QUERY = `[out:json][timeout:90];
(
  relation["route"="subway"](${BBOX});
  relation["route"="light_rail"](${BBOX});
  relation["route"="train"]["ref"~"^S[0-9]"](${BBOX});
)->.routes;
.routes out geom;
node(r.routes)["name"];
out;`;

// Walking model for "x minutes on foot". 80 m/min is the usual 4.8 km/h
// Gehminute; the detour factor turns the straight-line distance we can
// actually compute into an approximate street-network walk (no routing
// engine here). 10 minutes therefore means ~615 m as the crow flies.
export const WALK_METERS_PER_MINUTE = 80;
export const WALK_DETOUR_FACTOR = 1.3;

export function transitFilePath(dataDir) {
  return join(dataDir, TRANSIT_FILE);
}

function readCache(dataDir) {
  try {
    return JSON.parse(readFileSync(transitFilePath(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

/** Line geometry for the map overlay. Stations are stripped — /api/scan/transit
 *  ships this to every page load and the map has no use for them. */
export function readTransitLines(dataDir) {
  const cache = readCache(dataDir);
  return { generated_at: cache?.generated_at ?? null, lines: cache?.lines ?? [] };
}

/** Station coordinates for the report's walking-distance filter. Empty when the
 *  cache predates stations — callers must treat that as "unknown", not "none". */
export function readTransitStations(dataDir) {
  const cache = readCache(dataDir);
  return { generated_at: cache?.generated_at ?? null, stations: cache?.stations ?? [] };
}

/**
 * Group route relations by ref (a line has one relation per direction),
 * dedupe member ways, and round coordinates — 1e-5° is ~1 m, plenty for a
 * map overlay and it halves the JSON size.
 */
export function toLines(elements) {
  const byRef = new Map();
  for (const rel of elements || []) {
    if (rel.type && rel.type !== 'relation') continue;
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

/**
 * Named stop nodes of the route relations, deduped by name + rounded position.
 * A station has one stop node per direction and per line calling at it; they sit
 * tens of metres apart, so all of them are kept — the nearest one is the honest
 * answer for "how far to the platform" and the whole set costs ~15 kB.
 */
export function toStations(elements) {
  const seen = new Set();
  const stations = [];
  for (const node of elements || []) {
    if (node.type !== 'node' || node.lat == null || node.lon == null) continue;
    const name = node.tags?.name;
    if (!name) continue;
    const lat = Math.round(node.lat * 1e5) / 1e5;
    const lng = Math.round(node.lon * 1e5) / 1e5;
    const key = `${name}|${lat}|${lng}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stations.push({ name, lat, lng });
  }
  return stations.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

/** Great-circle distance in metres. */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Straight-line metres to approximate minutes on foot (see the walk model above). */
export function walkMinutes(meters) {
  return (meters * WALK_DETOUR_FACTOR) / WALK_METERS_PER_MINUTE;
}

/**
 * Closest U-/S-Bahn stop to a point, as { name, meters, minutes }.
 * Returns null for missing coordinates or an empty station list.
 */
export function nearestStation(lat, lng, stations = []) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best = null;
  for (const station of stations) {
    const meters = haversineMeters(lat, lng, station.lat, station.lng);
    if (!best || meters < best.meters) best = { name: station.name, meters };
  }
  return best ? { ...best, minutes: walkMinutes(best.meters) } : null;
}

/** Lower-case, ß→ss, parenthetical suffix stripped: "Lattenkamp (Sporthalle)" → "lattenkamp". */
function normalizeStationName(name) {
  return String(name ?? '').toLowerCase().replace(/ß/g, 'ss')
    .replace(/\(.*?\)/g, '').replace(/[^a-z0-9äöüé]+/g, ' ').trim();
}

/** Andrew's monotone chain; returns the hull as an [lng, lat] ring. */
function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (input) => {
    const out = [];
    for (const p of input) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...build(pts), ...build([...pts].reverse())];
}

function inPolygon(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Stops "between" the anchor (Hbf) and the named outer stations: everything
 * inside the convex hull of the anchor's stop nodes and the outer stops. The
 * transit cache keeps no stop order per line, so this is a geographic wedge,
 * not a walk along the track — it also takes in stops on neighbouring lines.
 * Returns { stations, missing }: the stops inside the hull, and the requested
 * names the cache has no stop for (a hull built from a partial list would
 * silently shrink, so callers should treat a non-empty `missing` as a fault).
 */
export function stationsWithinRegion(stations = [], outerNames = [], anchorName = 'Hamburg Hauptbahnhof') {
  const anchor = normalizeStationName(anchorName);
  const anchorStops = stations.filter((s) => normalizeStationName(s.name) === anchor);
  const missing = [];
  const outer = [];
  for (const name of outerNames) {
    const want = normalizeStationName(name);
    const hits = stations.filter((s) => normalizeStationName(s.name) === want);
    if (hits.length) outer.push(...hits); else missing.push(name);
  }
  if (!anchorStops.length || !outer.length) return { stations: [], missing };
  const ring = convexHull([...anchorStops, ...outer].map((s) => [s.lng, s.lat]));
  return { stations: stations.filter((s) => inPolygon(s.lng, s.lat, ring)), missing };
}

/** Fetch + cache transit lines if the cache is missing or stale. Never throws. */
export async function ensureTransitLines(dataDir, { log = () => {} } = {}) {
  const path = transitFilePath(dataDir);
  try {
    // A cache written before stations existed is stale regardless of age —
    // otherwise the report's walking-distance filter sits blind for up to a
    // month after the upgrade.
    if (existsSync(path) && Date.now() - statSync(path).mtimeMs < MAX_AGE_MS
        && readTransitStations(dataDir).stations.length > 0) return;
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
      const stations = toStations(data.elements);
      if (!stations.length) throw new Error('no station nodes in reply');
      writeFileSync(path, JSON.stringify({ generated_at: new Date().toISOString(), lines, stations }));
      log(`Transit lines cached: ${lines.length} route(s), ${stations.length} stop(s), ${Math.round(statSync(path).size / 1024)} kB`);
      return;
    } catch (err) {
      log(`WARN: transit line fetch failed (${endpoint}): ${err.message}`);
    }
  }
}
