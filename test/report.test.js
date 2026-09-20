// Tests for engine/report.js — SMTP config resolution + report gating.
// Run: node --test test/report.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HomelanderDB } from '../engine/db.js';
import {
  buildScanReportHtml, filterReportListings, isHouseListing, markApproxCoords,
  maybeSendWeeklyReport, resolveReportCriteria, resolveReportSmtp,
} from '../engine/report.js';

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

describe('resolveReportCriteria', () => {
  it('defaults to 80 m² / 4 rooms / 10 walking minutes', () => {
    assert.deepEqual(resolveReportCriteria({}), { minSize: 80, minRooms: 4, maxWalkMinutes: 10, westStations: ['Lutterothstraße', 'Langenfelde', 'Bahrenfeld', 'Lattenkamp', 'Sierichstraße'],
      extraStations: resolveReportCriteria({}).extraStations });
  });

  it('takes overrides from env and treats 0 as "criterion off"', () => {
    assert.deepEqual(resolveReportCriteria({
      HOMELANDER_REPORT_MIN_SIZE: '65',
      HOMELANDER_REPORT_MIN_ROOMS: '0',
      HOMELANDER_REPORT_MAX_WALK_MINUTES: '15',
      HOMELANDER_REPORT_WEST_STATIONS: 'Altona, Stellingen',
    }), { minSize: 65, minRooms: 0, maxWalkMinutes: 15, westStations: ['Altona', 'Stellingen'],
      extraStations: resolveReportCriteria({}).extraStations });
    assert.deepEqual(resolveReportCriteria({ HOMELANDER_REPORT_WEST_STATIONS: '' }).westStations, []);
  });

  it('falls back on blank or unparseable values rather than filtering everything out', () => {
    assert.deepEqual(resolveReportCriteria({
      HOMELANDER_REPORT_MIN_SIZE: '',
      HOMELANDER_REPORT_MIN_ROOMS: 'vier',
      HOMELANDER_REPORT_MAX_WALK_MINUTES: '-3',
    }), { minSize: 80, minRooms: 4, maxWalkMinutes: 10, westStations: ['Lutterothstraße', 'Langenfelde', 'Bahrenfeld', 'Lattenkamp', 'Sierichstraße'],
      extraStations: resolveReportCriteria({}).extraStations });
  });
});

describe('filterReportListings', () => {
  // Hoheluftbrücke; ~615 m away is the 10-minute boundary.
  const stations = [{ name: 'Hoheluftbrücke', lat: 53.5793, lng: 9.9727 }];
  const near = { lat: 53.5799, lng: 9.9735 };           // ~80 m
  const far = { lat: 53.5973, lng: 9.9727 };            // ~2 km
  const criteria = { stations, minSize: 80, minRooms: 4, maxWalkMinutes: 10 };
  const flat = (over) => ({ expose_id: 'x', size: 90, rooms: 4, ...near, ...over });

  it('keeps a listing that clears all three thresholds and attaches the walk', () => {
    const { kept, dropped } = filterReportListings([flat()], criteria);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].walk.name, 'Hoheluftbrücke');
    assert.ok(kept[0].walk.minutes < 2);
    assert.equal(dropped.total, 0);
  });

  it('drops listings below the size or room thresholds', () => {
    const { kept, dropped } = filterReportListings(
      [flat({ size: 79.9 }), flat({ rooms: 3.5 }), flat()], criteria);
    assert.equal(kept.length, 1);
    assert.deepEqual([dropped.size, dropped.rooms, dropped.total], [1, 1, 2]);
  });

  it('accepts exactly the threshold values', () => {
    const { kept } = filterReportListings([flat({ size: 80, rooms: 4 })], criteria);
    assert.equal(kept.length, 1);
  });

  it('drops listings too far from a stop, and those with no coordinates at all', () => {
    const { kept, dropped } = filterReportListings(
      [flat(far), flat({ lat: null, lng: null })], criteria);
    assert.equal(kept.length, 0);
    assert.equal(dropped.transit, 2);
  });

  it('drops unknown size or rooms rather than letting them through', () => {
    const { kept, dropped } = filterReportListings(
      [flat({ size: null }), flat({ rooms: undefined }), flat({ size: 0, rooms: 0 })], criteria);
    assert.equal(kept.length, 0);
    assert.equal(dropped.total, 3);
  });

  it('skips the transit criterion when no stations are cached, instead of emptying the mail', () => {
    const { kept, dropped, transitSkipped } = filterReportListings(
      [flat(far)], { ...criteria, stations: [] });
    assert.equal(transitSkipped, true);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].walk, undefined);
    assert.equal(dropped.transit, 0);
  });

  it('applies no thresholds when all are zero', () => {
    const { kept, transitSkipped } = filterReportListings(
      [flat({ size: 20, rooms: 1, ...far })],
      { stations, minSize: 0, minRooms: 0, maxWalkMinutes: 0 });
    assert.equal(kept.length, 1);
    assert.equal(transitSkipped, false);
    assert.equal(kept[0].walk.name, 'Hoheluftbrücke');   // still shown, just not filtered on
  });
});

describe('markApproxCoords', () => {
  it('flags coordinates that are just the postcode centroid', () => {
    const db = new HomelanderDB(':memory:');
    try {
      db.setGeoCache('20144', 53.57, 9.98);
      const [centroid, exact, noPostcode] = markApproxCoords(db, [
        { postcode: '20144 Hamburg', lat: 53.57, lng: 9.98 },
        { postcode: '20144', lat: 53.5712, lng: 9.9814 },
        { postcode: null, lat: 53.57, lng: 9.98 },
      ]);
      assert.equal(centroid.coord_approx, true);
      assert.equal(exact.coord_approx, undefined);
      assert.equal(noPostcode.coord_approx, undefined);
    } finally { db.close(); }
  });
});

describe('buildScanReportHtml with criteria', () => {
  const listing = {
    filter_name: 'Hamburg Kauf', title: 'Altbau', price: 800000, size: 92, rooms: 4,
    address: '20249 Hamburg', url: 'https://x/1', source: 'is24', expose_id: '1',
    walk: { name: 'Hoheluftbrücke', meters: 500, minutes: 8.1 },
  };

  it('shows the criteria, the walking time and what was filtered out', () => {
    const html = buildScanReportHtml({
      listings: [listing],
      criteria: { minSize: 80, minRooms: 4, maxWalkMinutes: 10 },
      dropped: { size: 3, rooms: 2, transit: 5, total: 10 },
    });
    assert.match(html, /ab 80 m² · ab 4 Zimmer · max\. 10 Min zu Fuß zur U-\/S-Bahn/);
    assert.match(html, /8 Min zu Hoheluftbrücke/);
    assert.match(html, /10 weitere Angebote entsprachen den Kriterien nicht \(3 zu klein, 2 zu wenige Zimmer, 5 zu weit von der Bahn\)/);
    assert.doesNotMatch(html, /ÖPNV-Filter wurde/);
  });

  it('marks postcode-centroid distances as approximate', () => {
    const html = buildScanReportHtml({ listings: [{ ...listing, coord_approx: true }] });
    assert.match(html, /ca\. 8 Min zu Hoheluftbrücke/);
  });

  it('omits zero counts from the filtered-out breakdown', () => {
    const html = buildScanReportHtml({
      listings: [], dropped: { size: 0, rooms: 0, transit: 4, total: 4 },
    });
    assert.match(html, /4 weitere Angebote entsprachen den Kriterien nicht \(4 zu weit von der Bahn\)/);
    assert.doesNotMatch(html, /0 zu klein/);
  });

  it('escapes station names', () => {
    const html = buildScanReportHtml({
      listings: [{ ...listing, walk: { name: '<script>', meters: 1, minutes: 1 } }],
    });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  it('warns instead of lying when the transit filter could not run', () => {
    const html = buildScanReportHtml({
      listings: [], criteria: { minSize: 80, minRooms: 4, maxWalkMinutes: 10 }, transitSkipped: true,
    });
    assert.match(html, /ÖPNV-Filter wurde diese Woche übersprungen/);
    assert.match(html, /Keine Angebote in diesem Zeitraum, die den Kriterien entsprechen/);
  });
});

describe('houses and the west region', () => {
  const hbf = [
    { name: 'Hamburg Hauptbahnhof', lat: 53.5522, lng: 10.0081 },
  ];
  const outer = [
    { name: 'Bahrenfeld', lat: 53.56, lng: 9.911 },
    { name: 'Langenfelde', lat: 53.5797, lng: 9.9308 },
    { name: 'Lattenkamp (Sporthalle)', lat: 53.5997, lng: 9.9946 },
  ];
  const inside = { name: 'Holstenstraße', lat: 53.5617, lng: 9.9499 };
  const east = { name: 'Berliner Tor', lat: 53.5527, lng: 10.0248 };
  const stations = [...hbf, ...outer, inside, east];
  const criteria = {
    stations, minSize: 80, minRooms: 4, maxWalkMinutes: 10,
    westStations: ['Bahrenfeld', 'Langenfelde', 'Lattenkamp'],
  };
  const flat = (over) => ({ expose_id: 'x', size: 90, rooms: 4, ...over });

  it('recognises house searches by their URL', () => {
    assert.equal(isHouseListing({ filter_url: 'https://www.kleinanzeigen.de/s-haus-kaufen/hamburg/c208l9409' }), true);
    assert.equal(isHouseListing({ filter_url: 'https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/haus-kaufen' }), true);
    assert.equal(isHouseListing({ filter_url: 'https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/wohnung-kaufen' }), false);
    assert.equal(isHouseListing({}), false);
  });

  it('drops houses and counts them', () => {
    const { kept, dropped } = filterReportListings([
      flat({ lat: 53.5619, lng: 9.9501, filter_url: 'https://x.example/haus-kaufen' }),
      flat({ lat: 53.5619, lng: 9.9501, filter_url: 'https://x.example/wohnung-kaufen' }),
    ], criteria);
    assert.equal(kept.length, 1);
    assert.equal(dropped.house, 1);
    assert.equal(dropped.total, 1);
  });

  it('measures the walk only to stops between the Hbf and the named stations', () => {
    const { kept, dropped } = filterReportListings([
      flat({ lat: 53.5619, lng: 9.9501 }),   // next to Holstenstraße, inside the wedge
      flat({ lat: 53.5529, lng: 10.0250 }),  // next to Berliner Tor, east of the Hbf
    ], criteria);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].walk.name, 'Holstenstraße');
    assert.equal(dropped.transit, 1);
  });

  it('counts extra stops even when they lie outside the hull', () => {
    const stPauli = { name: 'St. Pauli', lat: 53.5509, lng: 9.97 };
    const { kept } = filterReportListings(
      [flat({ lat: 53.5511, lng: 9.9702 })],
      { ...criteria, stations: [...stations, stPauli], extraStations: ['St. Pauli'] });
    assert.equal(kept[0]?.walk.name, 'St. Pauli');
  });

  it('keeps the west filter when only an extra stop is missing from the cache', () => {
    const { kept, dropped } = filterReportListings(
      [flat({ lat: 53.5529, lng: 10.0250 })],
      { ...criteria, extraStations: ['Nirgendwo'] });
    assert.equal(kept.length, 0);
    assert.equal(dropped.transit, 1);
  });

  it('does not claim the west region in the mail when the walk filter is off', () => {
    const html = buildScanReportHtml({
      listings: [], criteria: { maxWalkMinutes: 0, westStations: ['Bahrenfeld'] },
    });
    assert.doesNotMatch(html, /westlich des Hbf/);
  });

  it('skips the west filter, and says so, when a named station is missing', () => {
    const { kept, regionSkipped } = filterReportListings(
      [flat({ lat: 53.5529, lng: 10.0250 })],
      { ...criteria, westStations: ['Bahrenfeld', 'Nirgendwo'] });
    assert.equal(regionSkipped, true);
    assert.equal(kept.length, 1);
  });

  it('says "nur Wohnungen" and names the region in the mail', () => {
    const html = buildScanReportHtml({ listings: [], criteria: { maxWalkMinutes: 10, westStations: ['Bahrenfeld'] } });
    assert.match(html, /nur Wohnungen/);
    assert.match(html, /westlich des Hbf \(bis Bahrenfeld\)/);
  });
});
