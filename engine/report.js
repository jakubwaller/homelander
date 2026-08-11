// Weekly scan report — HTML summary of flats found by scan-mode searches,
// delivered via SMTP (see engine/smtp-mailer.js). In Docker the settings
// come from HOMELANDER_SMTP_* env vars (ProtonMail SMTP token pattern, cf.
// smtp.protonmail.ch:587 STARTTLS); on the desktop from Settings → report.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendMail } from './smtp-mailer.js';

const REPORT_STATE_FILE = '.last-scan-report';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtPrice(value) {
  return value > 0 ? `${Math.round(value).toLocaleString('de-DE')}\u00a0€` : '–';
}

/** Build the HTML body for a scan report. */
export function buildScanReportHtml({ listings = [], sinceIso, generatedAt = new Date() }) {
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
        <td style="padding:6px 8px;border-bottom:1px solid #eee;white-space:nowrap;">${l.size > 0 ? `${l.size}\u00a0m²` : '–'} · ${l.rooms > 0 ? `${l.rooms}\u00a0Zi.` : '–'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#777;font-size:12px;">${esc(l.source || 'is24')}</td>
      </tr>`;
    }).join('\n');
    return `<h3 style="margin:20px 0 6px;color:#333;">${esc(name)} <span style="color:#999;font-weight:400;">(${group.length})</span></h3>
      <table style="border-collapse:collapse;width:100%;font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;">${rows}</table>`;
  }).join('\n');

  const since = sinceIso ? new Date(sinceIso).toLocaleDateString('de-DE') : '';
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#222;max-width:720px;margin:0 auto;padding:16px;">
    <h2 style="color:#B8860B;margin-bottom:4px;">Homelander Kaufradar</h2>
    <p style="color:#777;margin-top:0;">${listings.length} Angebote${since ? ` seit ${since}` : ''} · Stand ${generatedAt.toLocaleString('de-DE')}</p>
    ${sections || '<p>Keine neuen Angebote in diesem Zeitraum.</p>'}
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
  const listings = db.getScanListings({ sinceIso, limit: 500 });

  try {
    const html = buildScanReportHtml({ listings, sinceIso });
    await sendMail(
      { ...smtp, to: recipient },
      { subject: `Homelander Kaufradar — ${listings.length} Angebote diese Woche`, html }
    );
    writeReportState(dataDir, new Date().toISOString());
    log(`Weekly scan report sent (${listings.length} listings)`);
    return { sent: true, count: listings.length };
  } catch (err) {
    log(`Weekly scan report failed: ${err.message}`);
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}
