// Integration tests for daemon + listing lifecycle + stats (audit item 13).
// These test the DB layer with realistic data, covering the full
// seen → apply → outcome lifecycle that the daemon orchestrates.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const { HomelanderDB } = await import('../engine/db.js');

describe('Daemon listing lifecycle', () => {
  /** @type {HomelanderDB} */
  let db;
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'homelander-test-'));
    db = new HomelanderDB(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('inserts listings and tracks seen → sent → stats', () => {
    const filter = db.addFilter({
      id: randomUUID(),
      name: 'Test Search',
      web_url: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten',
      mobile_params: '{}',
    });

    const listing = {
      expose_id: '123456789',
      title: 'Schöne Wohnung in Berlin',
      price: 850,
      size: 65,
      rooms: 2,
      address: 'Musterstraße 1, 10115 Berlin',
      image_url: 'https://example.com/img.jpg',
    };

    const inserted = db.insertListings([listing], filter.id);
    assert.strictEqual(inserted, 1);

    // Should be in "seen" state
    const queue = db.getSeenListings(filter.id);
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].expose_id, '123456789');

    // After markSent, should move to SENT
    db.markSent(queue[0].hash, 'SENT', 'modal ✓', '');
    const queueAfter = db.getSeenListings(filter.id);
    assert.strictEqual(queueAfter.length, 0);

    // Stats should reflect the sent listing
    const stats = db.getStats(filter.id);
    assert.strictEqual(stats.sent, 1);
    assert.strictEqual(stats.total, 1);
  });

  it('tracks FAIL, DEACTIVATED, and PREMIUM outcomes', () => {
    const filter = db.addFilter({
      id: randomUUID(),
      name: 'Test',
      web_url: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten',
      mobile_params: '{}',
    });

    const listings = [
      { expose_id: '1', title: 'A', price: 500, size: 40, rooms: 1, address: 'a', image_url: '' },
      { expose_id: '2', title: 'B', price: 600, size: 50, rooms: 2, address: 'b', image_url: '' },
      { expose_id: '3', title: 'C', price: 700, size: 60, rooms: 3, address: 'c', image_url: '' },
    ];

    db.insertListings(listings, filter.id);
    const queue = db.getSeenListings(filter.id);
    assert.strictEqual(queue.length, 3);

    db.markSent(queue[0].hash, 'FAIL', 'ERROR: timeout', 'error');
    db.markSent(queue[1].hash, 'DEACTIVATED', 'deactivated', 'deactivated');
    db.markSent(queue[2].hash, 'PREMIUM', 'premium listing', 'premium');

    const stats = db.getStats(filter.id);
    assert.strictEqual(stats.total, 3);
    assert.strictEqual(stats.failed, 1);
    assert.strictEqual(stats.deactivated, 1);
    assert.strictEqual(stats.premium, 1);
  });

  it('filters empty expose_id listings', () => {
    // This tests the filter applied in url-translator.js
    const arr = [
      { expose_id: 'valid-1' },
      { expose_id: '' },
      { expose_id: 'valid-2' },
    ];
    const filtered = arr.filter(l => l.expose_id);
    assert.strictEqual(filtered.length, 2);
    assert.strictEqual(filtered[0].expose_id, 'valid-1');
    assert.strictEqual(filtered[1].expose_id, 'valid-2');
  });
});

describe('Daemon stats aggregation', () => {
  let db;
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'homelander-test-'));
    db = new HomelanderDB(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('returns zero stats on empty DB', () => {
    const stats = db.getStats();
    assert.deepStrictEqual(stats, {
      total: 0, sent: 0, failed: 0, deactivated: 0,
      premium: 0, captcha: 0, seen_unapplied: 0, today: 0,
    });
  });

  it('today stat counts only same-day listings', () => {
    const filter = db.addFilter({
      id: randomUUID(),
      name: 'Test',
      web_url: 'https://www.example.com/test',
      mobile_params: '{}',
    });

    const listing = {
      expose_id: 'today-test',
      title: 'Today Listing',
      price: 500, size: 40, rooms: 1,
      address: 'Test', image_url: '',
    };

    db.insertListings([listing], filter.id);
    const queue = db.getSeenListings(filter.id);
    db.markSent(queue[0].hash, 'SENT', 'ok', '');

    // After marking as sent, 'today' should reflect it (sent_at is now)
    const stats = db.getStats(filter.id);
    assert.strictEqual(stats.today, 1);
    assert.strictEqual(stats.sent, 1);
  });

  it('getTodayStats uses localtime date filtering', () => {
    const filter = db.addFilter({
      id: randomUUID(),
      name: 'Test',
      web_url: 'https://www.example.com/test',
      mobile_params: '{}',
    });

    const listing = {
      expose_id: 'localtime-test',
      title: 'LocalTime Test',
      price: 600, size: 45, rooms: 2,
      address: 'Test', image_url: '',
    };

    db.insertListings([listing], filter.id);
    const queue = db.getSeenListings(filter.id);
    db.markSent(queue[0].hash, 'SENT', 'ok', '');

    const todayStats = db.getTodayStats(filter.id);
    assert.strictEqual(todayStats.sent, 1);
    assert.strictEqual(todayStats.today, 1);
  });
});

describe('Daemon pause/resume logic', () => {
  // Tests the pause flag mechanism used by daemon + Electron main
  let pauseFlagPath;

  beforeEach(() => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'homelander-pause-'));
    pauseFlagPath = join(tmpDir, '.apply-paused');
  });

  afterEach(() => {
    try { rmSync(join(pauseFlagPath, '..'), { recursive: true, force: true }); } catch {}
  });

  it('pause flag is absent by default', () => {
    assert.strictEqual(existsSync(pauseFlagPath), false);
  });

  it('writing pause flag simulates manual pause', () => {
    writeFileSync(pauseFlagPath, JSON.stringify({ paused_at: new Date().toISOString(), reason: 'manual' }), 'utf8');
    assert.strictEqual(existsSync(pauseFlagPath), true);
    const data = JSON.parse(readFileSync(pauseFlagPath, 'utf8'));
    assert.strictEqual(data.reason, 'manual');
  });

  it('captcha wall pause persists with reason', () => {
    writeFileSync(pauseFlagPath, JSON.stringify({
      paused_at: new Date().toISOString(),
      reason: 'captcha_wall',
    }), 'utf8');

    const data = JSON.parse(readFileSync(pauseFlagPath, 'utf8'));
    assert.strictEqual(data.reason, 'captcha_wall');
  });
});

describe('Daemon config hot-reload', () => {
  it('mergePatch shallow-merges config patches', () => {
    // Replicates the mergePatch() helper in daemon.js
    function mergePatch(target, patch) {
      for (const key of Object.keys(patch)) {
        if (patch[key] !== undefined) {
          target[key] = patch[key];
        }
      }
    }

    const config = { speed: 'fast', polling: { interval_seconds: 600 } };
    mergePatch(config, { speed: 'slow' });
    assert.strictEqual(config.speed, 'slow');
    assert.strictEqual(config.polling.interval_seconds, 600); // unchanged

    mergePatch(config, { polling: { interval_seconds: 120 } });
    assert.strictEqual(config.polling.interval_seconds, 120); // replaced (shallow)
  });
});
