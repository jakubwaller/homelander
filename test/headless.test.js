// Tests for engine/headless.js — search syncing for the Docker scanner.
// Run: node --test test/headless.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HomelanderDB } from '../engine/db.js';
import { parseSearchEntries, syncScanSearches } from '../engine/headless.js';

describe('parseSearchEntries', () => {
  it('parses comma/newline-separated env URLs', () => {
    const entries = parseSearchEntries({ env: 'https://a.example/x,\nhttps://b.example/y' });
    assert.deepEqual(entries.map(e => e.url), ['https://a.example/x', 'https://b.example/y']);
  });

  it('parses file entries as strings or objects', () => {
    const entries = parseSearchEntries({
      fileContent: ['https://a.example/x', { url: 'https://b.example/y', name: 'B' }, { nope: true }],
    });
    assert.deepEqual(entries, [
      { url: 'https://a.example/x', name: '' },
      { url: 'https://b.example/y', name: 'B' },
    ]);
  });

  it('returns empty for missing inputs', () => {
    assert.deepEqual(parseSearchEntries({}), []);
  });
});

describe('syncScanSearches', () => {
  it('adds valid searches as scan-mode filters and skips duplicates + invalid URLs', () => {
    const db = new HomelanderDB(':memory:');
    const logs = [];
    const entries = [
      { url: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-kaufen?price=-500000', name: 'Berlin Kauf' },
      { url: 'https://www.kleinanzeigen.de/s-wohnung-kaufen/berlin/c196l3331', name: '' },
      { url: 'https://example.com/not-supported', name: '' },
    ];
    const added = syncScanSearches(db, entries, { logFn: (m) => logs.push(m) });
    assert.equal(added, 2);
    const filters = db.getScanFilters();
    assert.equal(filters.length, 2);
    assert.ok(filters.every(f => f.mode === 'scan'));
    assert.ok(logs.some(m => m.includes('skipping invalid search URL')));

    // Re-sync is idempotent
    assert.equal(syncScanSearches(db, entries, { logFn: () => {} }), 0);
    db.close();
  });

  it('forces rent/apply URLs to scan mode (headless never applies)', () => {
    const db = new HomelanderDB(':memory:');
    const logs = [];
    const added = syncScanSearches(db, [
      { url: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten', name: 'Miete' },
    ], { logFn: (m) => logs.push(m) });
    assert.equal(added, 1);
    assert.equal(db.getScanFilters()[0].mode, 'scan');
    assert.ok(logs.some(m => m.includes('added as scan-only')));
    db.close();
  });
});
