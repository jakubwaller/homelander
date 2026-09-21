// Tests for Kaufradar accounts — auth helpers, per-user state, login, settings, CLI, per-user reports.
// Run: node --test test/accounts.test.js

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HomelanderDB } from '../engine/db.js';
import {
  createLoginThrottle, hashPassword, makeSession, normalizeSettings, userFromCookie, verifyPassword,
} from '../engine/auth.js';
import { startScanServer } from '../engine/scan-server.js';
import { run as runCli } from '../engine/users-cli.js';
import { criteriaFromSettings, filterReportListings, isHouseListing, legacyReportSettings, maybeSendWeeklyReport } from '../engine/report.js';
import { saveUpload, readUploads } from '../engine/uploads.js';

const SECRET = 'test-secret';
const tmp = () => mkdtempSync(join(tmpdir(), 'homelander-accounts-'));
const HASH = 'a'.repeat(16);

describe('auth helpers', () => {
  it('verifies passwords and rejects wrong ones', () => {
    const stored = hashPassword('correct horse');
    assert.equal(verifyPassword('correct horse', stored), true);
    assert.equal(verifyPassword('wrong', stored), false);
    assert.equal(verifyPassword('x', 'garbage'), false);
  });

  it('sessions: valid, tampered, expired, and dead after a password change', () => {
    const db = new HomelanderDB(':memory:');
    const { id } = db.createUser({ name: 'anna', passHash: hashPassword('pw-one-1234') });
    const user = db.getUser(id);
    const token = makeSession(SECRET, user);
    assert.equal(userFromCookie(SECRET, db, `hl_session=${encodeURIComponent(token)}`)?.name, 'anna');
    assert.equal(userFromCookie(SECRET, db, `hl_session=${encodeURIComponent(token + 'x')}`), null);
    assert.equal(userFromCookie('other-secret', db, `hl_session=${encodeURIComponent(token)}`), null);
    assert.equal(userFromCookie(SECRET, db, `hl_session=${encodeURIComponent(token)}`, Date.now() + 40 * 864e5), null);
    db.updateUser(id, { passHash: hashPassword('pw-two-1234') });
    assert.equal(userFromCookie(SECRET, db, `hl_session=${encodeURIComponent(token)}`), null);
    db.close();
  });

  it('login throttle locks a key after the limit', () => {
    const t = createLoginThrottle({ max: 2, windowMs: 1000 });
    t.fail('ip', 0); t.fail('ip', 10);
    assert.equal(t.blocked('ip', 20), true);
    assert.equal(t.blocked('ip', 5000), false);
    assert.equal(t.blocked('other', 20), false);
  });

  it('normalizeSettings clamps and defaults', () => {
    const s = normalizeSettings({ report: { enabled: true, type: 'villa', minSize: -5, minRooms: 'x', region: 'west', evil: 1 } });
    assert.deepEqual(s.report, { enabled: true, type: 'both', minSize: 0, minRooms: 0, maxWalkMinutes: 0, region: 'west' });
  });
});

describe('per-user state in the DB', () => {
  it('seen and favourite flags are independent per user', () => {
    const db = new HomelanderDB(':memory:');
    db.setListingSeen(HASH, true, 1);
    db.setListingFavorite(HASH, true, 1);
    assert.equal(db.isSeen(HASH, 1), true);
    assert.equal(db.isSeen(HASH, 2), false);
    assert.equal(db.isFavorite(HASH, 2), false);
    db.close();
  });

  it('the first account inherits legacy flags; the second does not', () => {
    const db = new HomelanderDB(':memory:');
    db.db.prepare('INSERT INTO scan_seen (hash) VALUES (?)').run(HASH);
    db.db.prepare('INSERT INTO scan_favorite (hash) VALUES (?)').run(HASH);
    const a = db.createUser({ name: 'anna', passHash: 'x' });
    const b = db.createUser({ name: 'ben', passHash: 'x' });
    assert.equal(a.first, true);
    assert.equal(b.first, false);
    assert.equal(db.isSeen(HASH, a.id), true);
    assert.equal(db.isFavorite(HASH, a.id), true);
    assert.equal(db.isSeen(HASH, b.id), false);
    db.close();
  });

  it('the first account also adopts flags set login-less (user 0) after the upgrade', () => {
    const db = new HomelanderDB(':memory:');
    db.setListingSeen(HASH, true, 0);
    db.setListingFavorite(HASH, true, 0);
    const { id } = db.createUser({ name: 'anna', passHash: 'x' });
    assert.equal(db.isSeen(HASH, id), true);
    assert.equal(db.isFavorite(HASH, id), true);
    db.close();
  });

  it('user names are unique case-insensitively; delete drops the flags', () => {
    const db = new HomelanderDB(':memory:');
    const { id } = db.createUser({ name: 'Anna', passHash: 'x' });
    assert.throws(() => db.createUser({ name: 'anna', passHash: 'x' }));
    db.setListingSeen(HASH, true, id);
    assert.equal(db.deleteUser(id), true);
    assert.equal(db.isSeen(HASH, id), false);
    db.close();
  });
});

describe('accounts over HTTP', () => {
  let dir, db, srv, base, cookieA, cookieB;
  const call = (path, { method = 'GET', body, cookie, raw } = {}) => fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body && !raw ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const login = async (name, password) => {
    const res = await call('/api/login', { method: 'POST', body: { name, password } });
    return { res, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };

  before(async () => {
    dir = tmp();
    db = new HomelanderDB(join(dir, 'homelander.db'));
    db.createUser({ name: 'anna', passHash: hashPassword('anna-password-1') });
    db.createUser({ name: 'ben', passHash: hashPassword('ben-password-1') });
    srv = await startScanServer(() => db, { port: 0, dataDir: dir, authSecret: SECRET });
    base = `http://127.0.0.1:${srv.port}`;
    cookieA = (await login('anna', 'anna-password-1')).cookie;
    cookieB = (await login('ben', 'ben-password-1')).cookie;
  });
  after(async () => { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('requires a session: page redirects, API answers 401, login page is public', async () => {
    const page = await call('/');
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login');
    assert.equal((await call('/api/scan/listings')).status, 401);
    assert.equal((await call('/media/abc/x.jpg')).status, 401);
    const form = await call('/login');
    assert.equal(form.status, 200);
    assert.match(await form.text(), /Anmelden/);
  });

  it('rejects a wrong password and sets an HttpOnly cookie on success', async () => {
    const bad = await login('anna', 'nope');
    assert.equal(bad.res.status, 401);
    assert.equal(bad.cookie, '');
    const ok = await call('/api/login', { method: 'POST', body: { name: 'anna', password: 'anna-password-1' } });
    assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await call('/', { cookie: cookieA })).status, 200);
  });

  it('keeps seen and favourites separate per user', async () => {
    await call('/api/scan/favorite', { method: 'POST', cookie: cookieA, body: { hash: HASH, favorite: true } });
    const list = async (cookie) => (await (await call('/api/scan/projects', { cookie })).json()).projects;
    assert.equal(db.isFavorite(HASH, db.getUserByName('anna').id), true);
    assert.equal(db.isFavorite(HASH, db.getUserByName('ben').id), false);
    assert.ok(Array.isArray(await list(cookieB)));
  });

  it('keeps uploads separate per user', async () => {
    const put = await call(`/api/scan/files/${HASH}?name=plan.pdf`, { method: 'POST', cookie: cookieA, raw: true, body: Buffer.from('%PDF-1.4') });
    assert.equal(put.status, 200);
    const a = await (await call(`/api/scan/files/${HASH}`, { cookie: cookieA })).json();
    const b = await (await call(`/api/scan/files/${HASH}`, { cookie: cookieB })).json();
    assert.equal(a.files.length, 1);
    assert.equal(b.files.length, 0);
    assert.equal((await call(a.files[0].url, { cookie: cookieB })).status, 404);
    assert.equal((await call(a.files[0].url, { cookie: cookieA })).status, 200);
    assert.deepEqual((await (await call('/api/scan/files', { cookie: cookieB })).json()).counts, {});
  });

  it('saves settings per user and validates them', async () => {
    const good = await call('/api/me/settings', {
      method: 'POST', cookie: cookieB,
      body: { email: 'ben@example.com', settings: { report: { enabled: true, type: 'houses', minSize: 100, region: 'all' } } },
    });
    assert.equal(good.status, 200);
    const me = await (await call('/api/me', { cookie: cookieB })).json();
    assert.equal(me.email, 'ben@example.com');
    assert.equal(me.settings.report.type, 'houses');
    assert.equal((await (await call('/api/me', { cookie: cookieA })).json()).settings.report.enabled, false);
    const noMail = await call('/api/me/settings', { method: 'POST', cookie: cookieA, body: { email: '', settings: { report: { enabled: true } } } });
    assert.equal(noMail.status, 400);
    const badMail = await call('/api/me/settings', { method: 'POST', cookie: cookieA, body: { email: 'nope', settings: {} } });
    assert.equal(badMail.status, 400);
  });

  it('changes a password, invalidating the old cookie', async () => {
    const wrong = await call('/api/me/password', { method: 'POST', cookie: cookieB, body: { current: 'x', next: 'brand-new-password' } });
    assert.equal(wrong.status, 403);
    const short = await call('/api/me/password', { method: 'POST', cookie: cookieB, body: { current: 'ben-password-1', next: 'short' } });
    assert.equal(short.status, 400);
    const ok = await call('/api/me/password', { method: 'POST', cookie: cookieB, body: { current: 'ben-password-1', next: 'brand-new-password' } });
    assert.equal(ok.status, 200);
    assert.equal((await call('/api/me', { cookie: cookieB })).status, 401);
    assert.equal((await call('/api/me', { cookie: ok.headers.get('set-cookie').split(';')[0] })).status, 200);
  });

  it('a malformed cookie is treated as logged out, not a 500', async () => {
    assert.equal((await call('/api/me', { cookie: 'hl_session=%' })).status, 401);
  });

  it('throttles repeated bad logins', async () => {
    const results = [];
    for (let i = 0; i < 10; i++) results.push((await login('anna', 'wrong')).res.status);
    assert.equal(results.at(-1), 429);
  });
});

describe('users CLI', () => {
  it('refuses passwords shorter than 10 characters', () => {
    const db = new HomelanderDB(':memory:');
    const realExit = process.exit;
    const realErr = console.error;
    process.exit = (c) => { throw new Error(`exit ${c}`); };
    console.error = () => {};
    try {
      assert.throws(() => runCli(db, ['add', 'anna', '--password', 'short'], { out: () => {} }), /exit 1/);
      assert.equal(db.getUserByName('anna'), null);
    } finally { process.exit = realExit; console.error = realErr; db.close(); }
  });

  it('first account adopts legacy uploads, flags and the report clock; later ones start clean', () => {
    const dir = tmp();
    const db = new HomelanderDB(join(dir, 'h.db'));
    db.db.prepare('INSERT INTO scan_seen (hash) VALUES (?)').run(HASH);
    saveUpload(dir, HASH, 'a.pdf', Buffer.from('x'));
    writeFileSync(join(dir, '.last-scan-report'), JSON.stringify({ last_sent_at: '2026-09-15T08:00:00.000Z' }));
    const lines = [];
    const env = { HOMELANDER_REPORT_TO: 'owner@example.com', HOMELANDER_REPORT_ENABLED: 'true' };
    runCli(db, ['add', 'jakub', '--password', 'pw-pw-pw-pw'], { dataDir: dir, env, out: (l) => lines.push(l) });
    const first = db.getUserByName('jakub');
    assert.equal(first.is_admin, 1);
    assert.equal(first.email, 'owner@example.com');
    assert.equal(first.last_report_at, '2026-09-15T08:00:00.000Z');
    assert.equal(JSON.parse(first.settings_json).report.region, 'west');
    assert.equal(db.isSeen(HASH, first.id), true);
    assert.equal(readUploads(dir, HASH, first.id).length, 1);
    assert.equal(existsSync(join(dir, 'uploads', HASH)), false);

    runCli(db, ['add', 'freund', '--email', 'f@example.com'], { dataDir: dir, env, out: (l) => lines.push(l) });
    const second = db.getUserByName('freund');
    assert.equal(second.is_admin, 0);
    assert.equal(JSON.parse(second.settings_json).report.enabled, false);
    assert.equal(db.isSeen(HASH, second.id), false);
    assert.match(lines.at(-1), /Password: \S{8,}/);

    runCli(db, ['remove', 'freund'], { dataDir: dir, env, out: () => {} });
    assert.equal(db.getUserByName('freund'), null);
    db.close(); rmSync(dir, { recursive: true, force: true });
  });
});

describe('per-user reports', () => {
  const SMTP_ENV = { HOMELANDER_SMTP_HOST: '127.0.0.1', HOMELANDER_SMTP_PORT: '1', HOMELANDER_SMTP_USER: 'x@example.eu', HOMELANDER_SMTP_PASSWORD: 't' };

  it('filterReportListings honours the property type', () => {
    const house = { filter_url: 'https://x/haus-kaufen/hamburg', size: 100, rooms: 5 };
    const flat = { filter_url: 'https://x/wohnung-kaufen/hamburg', size: 100, rooms: 5 };
    const keptOf = (type) => filterReportListings([house, flat], { type }).kept.length;
    assert.equal(keptOf('flats'), 1);
    assert.equal(keptOf('houses'), 1);
    assert.equal(keptOf('both'), 2);
    assert.equal(filterReportListings([house, flat], { type: 'houses' }).dropped.flat, 1);
    assert.equal(filterReportListings([house, flat]).kept[0], flat);   // legacy default: flats only
  });

  it('recognises villa and haus-mit-keller searches as houses', () => {
    for (const slug of ['haus-kaufen', 'villa-kaufen', 'haus-mit-keller-kaufen', 'neubauhaus-kaufen']) {
      assert.equal(isHouseListing({ filter_url: `https://x/${slug}/hamburg` }), true, slug);
    }
    assert.equal(isHouseListing({ filter_url: 'https://x/wohnung-kaufen/hamburg' }), false);
  });

  it('a first account only gets the mail on when the report was enabled', () => {
    assert.equal(legacyReportSettings({}).report.enabled, false);
    assert.equal(legacyReportSettings({ HOMELANDER_REPORT_ENABLED: 'true' }).report.enabled, true);
    assert.equal(legacyReportSettings({}, { report: { enabled: true } }).report.enabled, true);
  });

  it('criteriaFromSettings uses the env region only for "west"', () => {
    const rep = { type: 'houses', minSize: 90, minRooms: 4, maxWalkMinutes: 12, region: 'all' };
    assert.deepEqual(criteriaFromSettings(rep, {}).westStations, []);
    assert.ok(criteriaFromSettings({ ...rep, region: 'west' }, {}).westStations.length > 0);
  });

  it('with accounts: only opted-in users with an address are mailed, and a failed send keeps the clock', async () => {
    const dir = tmp();
    const db = new HomelanderDB(':memory:');
    db.addFilter({ id: 's', name: 'S', web_url: 'https://x/wohnung-kaufen', mobile_params: 'realestatetype=apartmentbuy', mode: 'scan', source: 'is24' });
    const off = db.createUser({ name: 'off', passHash: 'x', email: 'off@example.com' });
    const on = db.createUser({ name: 'on', passHash: 'x', email: 'on@example.com', settings: { report: { enabled: true, type: 'both' } } });
    db.createUser({ name: 'nomail', passHash: 'x', settings: { report: { enabled: true, type: 'both' } } });
    const logs = [];
    const result = await maybeSendWeeklyReport(db, {}, dir, { env: SMTP_ENV, log: (m) => logs.push(m) });
    assert.equal(result.sent, false);
    assert.ok(logs.some((m) => m.includes('for on failed')));
    assert.ok(!logs.some((m) => m.includes('off') || m.includes('nomail')));
    assert.equal(db.getUser(on.id).last_report_at, null);
    assert.equal(db.getUser(off.id).last_report_at, null);
    db.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('with accounts but no SMTP: mail_not_configured; recently mailed users are not due', async () => {
    const dir = tmp();
    const db = new HomelanderDB(':memory:');
    db.addFilter({ id: 's', name: 'S', web_url: 'https://x/wohnung-kaufen', mobile_params: 'realestatetype=apartmentbuy', mode: 'scan', source: 'is24' });
    const u = db.createUser({ name: 'on', passHash: 'x', email: 'on@example.com', settings: { report: { enabled: true, type: 'both' } } });
    assert.equal((await maybeSendWeeklyReport(db, {}, dir, { env: {} })).reason, 'mail_not_configured');
    db.updateUser(u.id, { lastReportAt: new Date().toISOString() });
    assert.equal((await maybeSendWeeklyReport(db, {}, dir, { env: SMTP_ENV })).reason, 'not_due');
    db.close(); rmSync(dir, { recursive: true, force: true });
  });
});
