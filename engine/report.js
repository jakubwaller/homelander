// Weekly scan report — HTML summary of flats found by scan-mode searches,
// delivered via SMTP (see engine/smtp-mailer.js). In Docker the settings
// come from HOMELANDER_SMTP_* env vars (ProtonMail SMTP token pattern, cf.
// smtp.protonmail.ch:587 STARTTLS); on the desktop from Settings → report.
//
// The report is deliberately narrower than the Kaufradar map: it only carries
// listings that clear the size / rooms / transit thresholds below, so the
// weekly mail stays a shortlist while the map keeps showing everything.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendMail } from './smtp-mailer.js';
import { nearestStation, readTransitStations } from './transit.js';

const REPORT_STATE_FILE = '.last-scan-report';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Report shortlist thresholds. Each is overridable via env and disabled by
// setting it to 0.
const DEFAULT_MIN_SIZE = 80;          // m²
const DEFAULT_MIN_ROOMS = 4;
const DEFAULT_MAX_WALK_MINUTES = 10;  // on foot to the nearest U-/S-Bahn stop

/** Non-negative number from env, falling back when unset or unparseable. */
function numEnv(env, key, fallback) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Report thresholds from the environment. */
export function resolveReportCriteria(env = process.env) {
  return {
    minSize: numEnv(env, 'HOMELANDER_REPORT_MIN_SIZE', DEFAULT_MIN_SIZE),
    minRooms: numEnv(env, 'HOMELANDER_REPORT_MIN_ROOMS', DEFAULT_MIN_ROOMS),
    maxWalkMinutes: numEnv(env, 'HOMELANDER_REPORT_MAX_WALK_MINUTES', DEFAULT_MAX_WALK_MINUTES),
  };
}

/**
 * Flag listings whose coordinates are only their postcode's centroid.
 *
 * Only IS24 listings get exposé coordinates; everything else falls back to
 * geocodePostcode(), which returns the same point for every flat sharing a
 * postcode. Comparing against geo_cache is how we tell the two apart — the
 * walking distance for a flagged listing is a postcode-level guess, and the
 * report says so rather than quietly presenting it as a measurement.
 */
export function markApproxCoords(db, listings) {
  const cache = new Map();
  return listings.map((listing) => {
    if (listing.lat == null || listing.lng == null || !listing.postcode) return listing;
    const code = String(listing.postcode).match(/\d{5}/)?.[0];
    if (!code) return listing;
    if (!cache.has(code)) {
      let geo = null;
      try { geo = db?.getGeoCache?.(code) || null; } catch { /* treat as exact */ }
      cache.set(code, geo);
    }
    const geo = cache.get(code);
    const isCentroid = geo && geo.lat != null
      && Math.abs(geo.lat - listing.lat) < 1e-9 && Math.abs(geo.lng - listing.lng) < 1e-9;
    return isCentroid ? { ...listing, coord_approx: true } : listing;
  });
}

/**
 * Apply the shortlist thresholds. Returns { kept, dropped, transitSkipped };
 * kept listings carry a `walk` field ({ name, meters, minutes }) when a stop
 * could be found.
 *
 * Unknown data fails the criterion it belongs to: a listing with no size, no
 * room count or no coordinates cannot be shown to clear a threshold, so it is
 * dropped rather than let through on the benefit of the doubt.
 *
 * The one exception is an empty station list — a missing or pre-upgrade
 * transit cache. That is a fault on our side, not a property of the listings,
 * so the transit criterion is skipped entirely instead of emptying the mail.
 */
export function filterReportListings(listings = [], {
  stations = [], minSize = 0, minRooms = 0, maxWalkMinutes = 0,
} = {}) {
  const transitSkipped = maxWalkMinutes > 0 && stations.length === 0;
  const walkLimit = transitSkipped ? 0 : maxWalkMinutes;
  const dropped = { size: 0, rooms: 0, transit: 0 };
  const kept = [];

  for (const listing of listings) {
    if (minSize > 0 && !(listing.size >= minSize)) { dropped.size++; continue; }
    if (minRooms > 0 && !(listing.rooms >= minRooms)) { dropped.rooms++; continue; }
    const walk = stations.length
      ? nearestStation(listing.lat, listing.lng, stations)
      : null;
    if (walkLimit > 0 && !(walk && walk.minutes <= walkLimit)) { dropped.transit++; continue; }
    kept.push(walk ? { ...listing, walk } : listing);
  }

  dropped.total = dropped.size + dropped.rooms + dropped.transit;
  return { kept, dropped, transitSkipped };
}

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtPrice(value) {
  return value > 0 ? `${Math.round(value).toLocaleString('de-DE')}\u00a0€` : '–';
}

/** "7 Min zu Eppendorfer Baum", prefixed with ca. for postcode-level coordinates. */
function fmtWalk(listing) {
  if (!listing.walk) return '';
  const minutes = Math.max(1, Math.round(listing.walk.minutes));
  const prefix = listing.coord_approx ? 'ca.\u00a0' : '';
  return `${prefix}${minutes}\u00a0Min zu ${esc(listing.walk.name)}`;
}

/** One-line summary of the thresholds the shortlist was built with. */
function fmtCriteria({ minSize = 0, minRooms = 0, maxWalkMinutes = 0 } = {}) {
  const parts = [];
  if (minSize > 0) parts.push(`ab ${minSize}\u00a0m²`);
  if (minRooms > 0) parts.push(`ab ${minRooms}\u00a0Zimmer`);
  if (maxWalkMinutes > 0) parts.push(`max. ${maxWalkMinutes}\u00a0Min zu Fuß zur U-/S-Bahn`);
  return parts.join(' · ');
}

/** Build the HTML body for a scan report. */
export function buildScanReportHtml({
  listings = [], sinceIso, generatedAt = new Date(),
  criteria = null, dropped = null, transitSkipped = false,
}) {
  const byFilter = new Map();
  for (const listing of listings) {
    const key = listing.filter_name || listing.filter_id || 'Suche';
    if (!byFilter.has(key)) byFilter.set(key, []);
    byFilter.get(key).push(listing);
  }

  const sections = [...byFilter.entries()].map(([name, group]) => {
    const rows = group.map((l) => {
      const perSqm = l.price > 0 && l.size > 0 ? `${Math.round(l.price / l.size).toLocaleString('de-DE')}\u00a0€/m²` : '';
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">
          <a href="${esc(l.url || '')}" style="color:#B8860B;text-decoration:none;font-weight:600;">${esc(l.title || l.expose_id)}</a>
          <div style="color:#777;font-size:12px;">${esc(l.address || '')}</div>
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;white-space:nowrap;text-align:right;">
          ${fmtPrice(l.price)}<div style="color:#777;font-size:12px;">${perSqm}</div>
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;white-space:nowrap;">
          ${l.size > 0 ? `${l.size}\u00a0m²` : '–'} · ${l.rooms > 0 ? `${l.rooms}\u00a0Zi.` : '–'}
          ${l.walk ? `<div style="color:#777;font-size:12px;">${fmtWalk(l)}</div>` : ''}
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#777;font-size:12px;">${esc(l.source || 'is24')}</td>
      </tr>`;
    }).join('\n');
    return `<h3 style="margin:20px 0 6px;color:#333;">${esc(name)} <span style="color:#999;font-weight:400;">(${group.length})</span></h3>
      <table style="border-collapse:collapse;width:100%;font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;">${rows}</table>`;
  }).join('\n');

  const since = sinceIso ? new Date(sinceIso).toLocaleDateString('de-DE') : '';
  const criteriaLine = fmtCriteria(criteria || {});
  // Say what the filter swallowed — an empty mail should never be ambiguous
  // between "nothing matched" and "the filter is broken".
  const breakdown = dropped ? [
    [dropped.size, 'zu klein'],
    [dropped.rooms, 'zu wenige Zimmer'],
    [dropped.transit, 'zu weit von der Bahn'],
  ].filter(([n]) => n > 0).map(([n, why]) => `${n} ${why}`).join(', ') : '';
  const droppedLine = dropped?.total > 0
    ? `${dropped.total} weitere Angebote entsprachen den Kriterien nicht`
      + `${breakdown ? ` (${breakdown})` : ''}. Alle Angebote stehen weiterhin im Kaufradar.`
    : '';
  const emptyText = criteriaLine
    ? 'Keine Angebote in diesem Zeitraum, die den Kriterien entsprechen.'
    : 'Keine neuen Angebote in diesem Zeitraum.';

  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#222;max-width:720px;margin:0 auto;padding:16px;">
    <h2 style="color:#B8860B;margin-bottom:4px;">Homelander Kaufradar</h2>
    <p style="color:#777;margin-top:0;">${listings.length} Angebote${since ? ` seit ${since}` : ''} · Stand ${generatedAt.toLocaleString('de-DE')}</p>
    ${criteriaLine ? `<p style="color:#777;margin-top:0;font-size:13px;">Kriterien: ${criteriaLine}</p>` : ''}
    ${transitSkipped ? '<p style="color:#B8860B;font-size:13px;">Hinweis: Keine Haltestellendaten verfügbar — der ÖPNV-Filter wurde diese Woche übersprungen.</p>' : ''}
    ${sections || `<p>${emptyText}</p>`}
    ${droppedLine ? `<p style="color:#aaa;font-size:12px;margin-top:16px;">${droppedLine}</p>` : ''}
    <p style="color:#aaa;font-size:12px;margin-top:24px;">Automatisch erstellt von Homelander (Scan-Modus — es wurden keine Bewerbungen versendet).</p>
  </body></html>`;
}

function readReportState(dataDir) {
  try {
    const raw = readFileSync(join(dataDir, REPORT_STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.last_sent_at || null;
  } catch {
    return null;
  }
}

function writeReportState(dataDir, iso) {
  writeFileSync(join(dataDir, REPORT_STATE_FILE), JSON.stringify({ last_sent_at: iso }), 'utf8');
}

/**
 * SMTP settings for the report: HOMELANDER_SMTP_* env vars first (Docker,
 * .env file), then the desktop app's config.report.smtp. Returns null when
 * neither is configured.
 *
 * ProtonMail: host smtp.protonmail.ch, port 587 (STARTTLS), user = the
 * custom-domain Proton address the SMTP token is paired with, password =
 * the SMTP token. Proton requires From to equal that address, hence the
 * from-defaults-to-user rule.
 */
export function resolveReportSmtp(env = process.env, report = {}) {
  if (env.HOMELANDER_SMTP_HOST) {
    return {
      host: env.HOMELANDER_SMTP_HOST,
      port: Number(env.HOMELANDER_SMTP_PORT) || 587,
      secure: env.HOMELANDER_SMTP_SECURE || 'starttls',
      user: env.HOMELANDER_SMTP_USER || '',
      pass: env.HOMELANDER_SMTP_PASSWORD || '',
      from: env.HOMELANDER_SMTP_FROM || env.HOMELANDER_SMTP_USER || '',
    };
  }
  return report?.smtp?.host ? { ...report.smtp } : null;
}

/**
 * Send the weekly scan report if enabled, configured, and due.
 * Enabled via config.report.enabled (desktop Settings) or the
 * HOMELANDER_REPORT_ENABLED env var (Docker).
 * Returns { sent, reason } — never throws.
 */
export async function maybeSendWeeklyReport(db, config, dataDir, { log = () => {}, force = false, env = process.env } = {}) {
  const report = config?.report || {};
  const enabled = report.enabled || String(env.HOMELANDER_REPORT_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) return { sent: false, reason: 'disabled' };
  const recipient = env.HOMELANDER_REPORT_TO || report.to || report.smtp?.to;
  const smtp = resolveReportSmtp(env, report);
  if (!recipient || !smtp) return { sent: false, reason: 'mail_not_configured' };

  const lastSent = readReportState(dataDir);
  const due = force || !lastSent || (Date.now() - new Date(lastSent).getTime()) >= WEEK_MS;
  if (!due) return { sent: false, reason: 'not_due' };

  const scanFilters = db.getScanFilters();
  if (scanFilters.length === 0) return { sent: false, reason: 'no_scan_filters' };

  const sinceIso = lastSent || new Date(Date.now() - WEEK_MS).toISOString();
  const found = db.getScanListings({ sinceIso, limit: 500 });

  const criteria = resolveReportCriteria(env);
  const { stations } = readTransitStations(dataDir);
  const { kept, dropped, transitSkipped } = filterReportListings(
    markApproxCoords(db, found), { ...criteria, stations }
  );
  if (transitSkipped) log('WARN: no transit stations cached — report skipped the walking-distance filter');

  try {
    const html = buildScanReportHtml({
      listings: kept, sinceIso, criteria, dropped, transitSkipped,
    });
    await sendMail(
      { ...smtp, to: recipient },
      { subject: `Homelander Kaufradar — ${kept.length} Angebote diese Woche`, html }
    );
    writeReportState(dataDir, new Date().toISOString());
    log(`Weekly scan report sent (${kept.length} of ${found.length} listings matched)`);
    return { sent: true, count: kept.length, dropped: dropped.total };
  } catch (err) {
    log(`Weekly scan report failed: ${err.message}`);
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}
