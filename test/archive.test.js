// Tests for listing expiry/archiving: schema v9, the portal checks, batch
// selection, the archived-aware queries and the weekly report.
// Run: node --test test/archive.test.js

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { HomelanderDB } from '../engine/db.js';
import { checkListingGone } from '../engine/sources.js';
import { createScanCycle } from '../engine/scan-cycle.js';
import { maybeSendWeeklyReport } from '../engine/report.js';

let originalFetch;
before(() => { originalFetch = globalThis.fetch; });
after(() => { globalThis.fetch = originalFetch; });

function newDb() {
  const db = new HomelanderDB(':memory:');
  db.addFilter({ id: 'f1', name: 'Test Kauf', web_url: 'https://example.com/s', mobile_params: 'realestatetype=apartmentbuy', mode: 'scan', source: 'is24' });
  return db;
}
function add(db, exposeId, price = 100000, source = 'is24') {
  db.insertListing({ expose_id: exposeId, title: `Wohnung ${exposeId}`, price, size: 60, rooms: 2, address: '10115 Berlin', url: `https://example.com/${exposeId}`, source, filter_id: 'f1' });
  return HomelanderDB.hashListing(exposeId, price);
}
const goneAt = (db, hash) => db.db.prepare('SELECT gone_at FROM listings WHERE hash = ?').get(hash).gone_at;

describe('schema v9', () => {
  it('adds gone_at/checked_at to a v8 DB without archiving anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'homelander-archive-'));
    const file = join(dir, 'homelander.db');
    try {
      const fresh = new HomelanderDB(file);
      fresh.addFilter({ id: 'f1', name: 'T', web_url: 'https://example.com/s', mobile_params: 'x', mode: 'scan' });
      add(fresh, '1', 100000); add(fresh, '1', 90000);
      fresh.close();
      // Turn it back into a v8 DB: no new columns, no marks.
      const old = new Database(file);
      old.exec('ALTER TABLE listings DROP COLUMN gone_at; ALTER TABLE listings DROP COLUMN checked_at; UPDATE schema_version SET version = 8;');
      old.close();

      const db = new HomelanderDB(file);
      assert.equal(db.db.prepare('SELECT version FROM schema_version').get().version, 9);
      assert.equal(goneAt(db, HomelanderDB.hashListing('1', 100000)), null);
      assert.equal(goneAt(db, HomelanderDB.hashListing('1', 90000)), null);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('checkListingGone', () => {
  const resp = (status, body = '', url = '') => ({ ok: status >= 200 && status < 300, status, url, text: async () => body });
  const is24 = { source: 'is24', expose_id: '1' };
  const ka = { source: 'kleinanzeigen', expose_id: 'ka-1', url: 'https://www.kleinanzeigen.de/s-anzeige/test/1-196-1' };

  it('IS24: 404 + ERROR_RESOURCE_NOT_FOUND is gone, 200 is live', async () => {
    globalThis.fetch = async () => resp(404, '{"message":"ERROR_RESOURCE_NOT_FOUND"}');
    assert.equal(await checkListingGone(is24), true);
    globalThis.fetch = async () => resp(200, '{}');
    assert.equal(await checkListingGone(is24), false);
  });

  it('IS24: 500, a bare 404 and a thrown error are undecided', async () => {
    globalThis.fetch = async () => resp(500);
    assert.equal(await checkListingGone(is24), null);
    globalThis.fetch = async () => resp(404, 'nginx');
    assert.equal(await checkListingGone(is24), null);
    globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
    assert.equal(await checkListingGone(is24), null);
  });

  it('Kleinanzeigen: redirect to a category page is gone, staying on /s-anzeige/ is live', async () => {
    globalThis.fetch = async () => resp(200, '', 'https://www.kleinanzeigen.de/s-wohnung-kaufen/berlin/c196l3331');
    assert.equal(await checkListingGone(ka), true);
    globalThis.fetch = async () => resp(200, '', ka.url);
    assert.equal(await checkListingGone(ka), false);
    globalThis.fetch = async () => resp(410);
    assert.equal(await checkListingGone(ka), true);
    globalThis.fetch = async () => resp(429);
    assert.equal(await checkListingGone(ka), null);
  });

  it('Kleinanzeigen: a redirect to a login, consent or home page is undecided', async () => {
    for (const to of ['https://www.kleinanzeigen.de/m-einloggen.html', 'https://www.kleinanzeigen.de/', 'https://consent.example.com/']) {
      globalThis.fetch = async () => resp(200, '', to);
      assert.equal(await checkListingGone(ka), null, to);
    }
  });
});

describe('expiry batch', () => {
  it('picks never-checked and >3 day old rows, oldest first, skipping gone and neubaukompass', () => {
    const db = newDb();
    const never = add(db, '1'), stale = add(db, '2'), fresh = add(db, '3'), gone = add(db, '4'), nk = add(db, '5', 1, 'neubaukompass');
    const now = Date.now();
    const ago = days => new Date(now - days * 864e5).toISOString();
    db.markListingChecked(stale, false, ago(4));
    db.markListingChecked(fresh, false, ago(2));
    db.markListingChecked(gone, true, ago(10));
    const rows = db.getListingsToCheck(30, ago(3)).map(r => r.hash);
    assert.deepEqual(rows, [never, stale]);
    assert.ok(!rows.includes(nk));
    assert.deepEqual(db.getListingsToCheck(1, ago(3)).map(r => r.hash), [never]);
  });

  it('skips listings of deleted searches', () => {
    const db = newDb();
    add(db, '1');
    db.removeFilter('f1');
    assert.deepEqual(db.getListingsToCheck(30, new Date().toISOString()), []);
  });

  it('checkExpiry marks gone/live and never archives an undecided row', async () => {
    const db = newDb();
    const a = add(db, '1'), b = add(db, '2'), c = add(db, '3');
    globalThis.fetch = async (u) => {
      if (String(u).endsWith('/1')) return { ok: false, status: 404, text: async () => 'ERROR_RESOURCE_NOT_FOUND' };
      if (String(u).endsWith('/2')) return { ok: true, status: 200 };
      return { ok: false, status: 503, text: async () => '' };
    };
    const { checkExpiry } = createScanCycle();
    assert.equal(await checkExpiry(db, 30, 0), 1);
    const row = h => db.db.prepare('SELECT gone_at, checked_at FROM listings WHERE hash = ?').get(h);
    assert.ok(row(a).gone_at && row(a).checked_at);
    assert.ok(!row(b).gone_at && row(b).checked_at);
    assert.ok(!row(c).gone_at && row(c).checked_at);
  });

  it('checkExpiry stops at the first undecided answer, and that row cannot jam the queue', async () => {
    const db = newDb();
    const a = add(db, '1'), b = add(db, '2');
    const row = h => db.db.prepare('SELECT gone_at, checked_at FROM listings WHERE hash = ?').get(h);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return { ok: false, status: 429, text: async () => '' }; };
    const { checkExpiry } = createScanCycle();
    assert.equal(await checkExpiry(db, 10, 0), 0);
    assert.equal(calls, 1);
    assert.ok(!row(a).gone_at && row(a).checked_at);   // moved to the back, not archived
    assert.equal(row(b).checked_at, null);
    // Next cycle the portal answers again: the batch starts at b, not at a.
    const asked = [];
    globalThis.fetch = async (u) => { asked.push(String(u)); return { ok: true, status: 200 }; };
    await checkExpiry(db, 10, 0);
    assert.deepEqual(asked.map(u => u.split('/').pop()), ['2']);
    assert.ok(row(b).checked_at);
  });
});

describe('getScanListings and archived rows', () => {
  it('hides archived rows by default, keeps favourites, opts in, and carries gone_at', () => {
    const db = newDb();
    const live = add(db, '1'), gone = add(db, '2'), favGone = add(db, '3');
    db.markListingChecked(gone, true);
    db.markListingChecked(favGone, true);
    db.setListingFavorite(favGone, true);
    const hashes = opts => db.getScanListings(opts).map(l => l.hash).sort();
    assert.deepEqual(hashes(), [live, favGone].sort());
    assert.deepEqual(hashes({ includeArchived: true }), [live, gone, favGone].sort());
    assert.ok(db.getScanListings().find(l => l.hash === favGone).gone_at);
  });

});

describe('weekly report', () => {
  it('does not offer archived listings', async () => {
    const db = newDb();
    add(db, '1');
    const gone = add(db, '2');
    db.markListingChecked(gone, true);
    db.setListingFavorite(gone, true); // survives getScanListings, but not the mail
    const server = createServer((s) => {
      let data = false;
      s.write('220 mock\r\n');
      s.on('data', (chunk) => {
        for (const line of String(chunk).split('\r\n')) {
          if (data) { if (line === '.') { data = false; s.write('250 OK\r\n'); } continue; }
          if (line === 'DATA') { data = true; s.write('354 go\r\n'); }
          else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
          else if (line) s.write('250 OK\r\n');
        }
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const dir = mkdtempSync(join(tmpdir(), 'homelander-archive-report-'));
    const logs = [];
    try {
      const result = await maybeSendWeeklyReport(db, {}, dir, {
        force: true, log: m => logs.push(m),
        env: {
          HOMELANDER_REPORT_ENABLED: 'true', HOMELANDER_REPORT_TO: 'me@example.com',
          HOMELANDER_SMTP_HOST: '127.0.0.1', HOMELANDER_SMTP_PORT: String(server.address().port),
          HOMELANDER_SMTP_SECURE: 'none', HOMELANDER_SMTP_FROM: 'a@example.com',
        },
      });
      assert.equal(result.sent, true, JSON.stringify(result));
      assert.match(logs.join('\n'), /of 1 listings matched/);
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
