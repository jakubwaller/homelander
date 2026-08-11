// Tests for engine/report.js — SMTP config resolution + report gating.
// Run: node --test test/report.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HomelanderDB } from '../engine/db.js';
import { resolveReportSmtp, maybeSendWeeklyReport, buildScanReportHtml } from '../engine/report.js';

describe('resolveReportSmtp', () => {
  it('prefers HOMELANDER_SMTP_* env vars with Proton-style defaults', () => {
    const smtp = resolveReportSmtp({
      HOMELANDER_SMTP_HOST: 'smtp.protonmail.ch',
      HOMELANDER_SMTP_USER: 'homelander@example.eu',
      HOMELANDER_SMTP_PASSWORD: 'token',
    }, { smtp: { host: 'ignored.example' } });
    assert.deepEqual(smtp, {
      host: 'smtp.protonmail.ch',
      port: 587,
      secure: 'starttls',
      user: 'homelander@example.eu',
      pass: 'token',
      from: 'homelander@example.eu',   // Proton: From must equal the token address
    });
  });

  it('falls back to the desktop config when no env host is set', () => {
    const smtp = resolveReportSmtp({}, { smtp: { host: '127.0.0.1', port: 1025, secure: 'starttls' } });
    assert.equal(smtp.host, '127.0.0.1');
  });

  it('returns null when nothing is configured', () => {
    assert.equal(resolveReportSmtp({}, {}), null);
    assert.equal(resolveReportSmtp({}, { smtp: {} }), null);
  });
});

describe('maybeSendWeeklyReport gating', () => {
  function tempDataDir() {
    return mkdtempSync(join(tmpdir(), 'homelander-report-'));
  }

  it('skips when disabled', async () => {
    const db = new HomelanderDB(':memory:');
    const dir = tempDataDir();
    try {
      const result = await maybeSendWeeklyReport(db, {}, dir, { env: {} });
      assert.deepEqual(result, { sent: false, reason: 'disabled' });
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('skips when enabled via env but SMTP/recipient missing', async () => {
    const db = new HomelanderDB(':memory:');
    const dir = tempDataDir();
    try {
      const result = await maybeSendWeeklyReport(db, {}, dir, {
        env: { HOMELANDER_REPORT_ENABLED: 'true' },
      });
      assert.equal(result.reason, 'mail_not_configured');
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('skips when configured but no scan filters exist', async () => {
    const db = new HomelanderDB(':memory:');
    const dir = tempDataDir();
    try {
      const result = await maybeSendWeeklyReport(db, {}, dir, {
        env: {
          HOMELANDER_REPORT_ENABLED: 'true',
          HOMELANDER_REPORT_TO: 'me@example.com',
          HOMELANDER_SMTP_HOST: 'smtp.protonmail.ch',
          HOMELANDER_SMTP_USER: 'homelander@example.eu',
          HOMELANDER_SMTP_PASSWORD: 'token',
        },
      });
      assert.equal(result.reason, 'no_scan_filters');
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('buildScanReportHtml', () => {
  it('groups listings by search and renders prices per m²', () => {
    const html = buildScanReportHtml({
      listings: [
        { filter_name: 'Berlin Kauf', title: 'Testwohnung', price: 300000, size: 60, rooms: 2, address: '10115 Berlin', url: 'https://x/1', source: 'is24', expose_id: '1' },
      ],
      sinceIso: '2026-08-01T00:00:00Z',
    });
    assert.match(html, /Berlin Kauf/);
    assert.match(html, /Testwohnung/);
    assert.match(html, /5\.000\u00a0€\/m²/);   // NBSP before the unit (German typography)
    assert.match(html, /keine Bewerbungen versendet/);
  });
});
