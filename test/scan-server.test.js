// Tests for engine/scan-server.js — Kaufradar HTTP API + page.
// Run: node --test test/scan-server.test.js

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HomelanderDB } from '../engine/db.js';
import { startScanServer } from '../engine/scan-server.js';

let dir, db, srv, srvFiles, hash;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homelander-scan-server-'));
  db = new HomelanderDB(join(dir, 'homelander.db'));
  db.addFilter({
    id: 'scan-1',
    name: 'Berlin Kauf',
    web_url: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-kaufen',
    mobile_params: 'realestatetype=apartmentbuy',
    mode: 'scan',
    source: 'is24',
  });
  db.addFilter({
    id: 'apply-1',
    name: 'Berlin Miete',
    web_url: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten',
    mobile_params: 'realestatetype=apartmentrent',
  });
  db.insertListings([
    { expose_id: '900001', title: 'Kaufwohnung', price: 300000, size: 60, rooms: 2, address: '10115 Berlin', postcode: '10115', image_url: '', url: 'https://x/1', source: 'is24' },
  ], 'scan-1');
  db.insertListings([
    { expose_id: '900002', title: 'Mietwohnung', price: 1200, size: 55, rooms: 2, address: '10245 Berlin', postcode: '10245', image_url: '', url: 'https://x/2', source: 'is24' },
  ], 'apply-1');
  hash = db.getScanListings()[0].hash;
  db.updateListingScanData(hash, { lat: 52.5, lng: 13.4, scan_json: { texts: [{ title: 'Lage', text: 'zentral' }] } });
  srv = await startScanServer(() => db, { port: 0 });
  srvFiles = await startScanServer(() => db, { port: 0, dataDir: dir });
});

after(async () => {
  await srvFiles?.close();
  await srv?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('scan-server', () => {
  it('serves the Kaufradar page at /', async () => {
    const resp = await fetch(srv.url);
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assert.match(html, /Kaufradar/);
    assert.match(html, /leaflet/);
  });

  it('lists only scan-mode filters', async () => {
    const { filters } = await (await fetch(`${srv.url}api/scan/filters`)).json();
    assert.equal(filters.length, 1);
    assert.equal(filters[0].id, 'scan-1');
  });

  it('returns scan listings with parsed details, excluding apply-mode listings', async () => {
    const data = await (await fetch(`${srv.url}api/scan/listings`)).json();
    assert.equal(data.count, 1);
    const listing = data.listings[0];
    assert.equal(listing.expose_id, '900001');
    assert.equal(listing.lat, 52.5);
    assert.deepEqual(listing.details.texts, [{ title: 'Lage', text: 'zentral' }]);
    assert.equal(listing.scan_json, undefined);
  });

  it('serves a single listing by hash', async () => {
    const { listing } = await (await fetch(`${srv.url}api/scan/listing/${hash}`)).json();
    assert.equal(listing.expose_id, '900001');
    assert.equal(listing.filter_name, 'Berlin Kauf');
  });

  it('404s for unknown paths and hashes', async () => {
    assert.equal((await fetch(`${srv.url}api/nope`)).status, 404);
    assert.equal((await fetch(`${srv.url}api/scan/listing/deadbeef00000000`)).status, 404);
  });

  it('rejects non-GET methods', async () => {
    assert.equal((await fetch(`${srv.url}api/scan/listings`, { method: 'POST' })).status, 405);
  });

  it('stars a listing and reports it back with the listings', async () => {
    let data = await (await fetch(`${srv.url}api/scan/listings`)).json();
    assert.equal(data.listings[0].favorite, 0);

    const resp = await fetch(`${srv.url}api/scan/favorite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash, favorite: true }),
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { hash, favorite: true });

    data = await (await fetch(`${srv.url}api/scan/listings`)).json();
    assert.equal(data.listings[0].favorite, 1);

    await fetch(`${srv.url}api/scan/favorite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash, favorite: false }),
    });
    data = await (await fetch(`${srv.url}api/scan/listings`)).json();
    assert.equal(data.listings[0].favorite, 0);
  });

  it('rejects a malformed favourite hash', async () => {
    const resp = await fetch(`${srv.url}api/scan/favorite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: '../../etc/passwd', favorite: true }),
    });
    assert.equal(resp.status, 400);
  });

  it('uploads, lists, downloads and deletes a document', async () => {
    const body = Buffer.from('%PDF-1.4 Preisliste');
    const up = await fetch(`${srvFiles.url}api/scan/files/${hash}?name=${encodeURIComponent('Preise & Info.pdf')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    assert.equal(up.status, 200);
    const { file } = await up.json();
    assert.equal(file.name, 'Preise & Info.pdf');
    assert.equal(file.size, body.length);

    const { files } = await (await fetch(`${srvFiles.url}api/scan/files/${hash}`)).json();
    assert.equal(files.length, 1);
    assert.equal(files[0].url, `/files/${hash}/${file.file}`);

    const { counts } = await (await fetch(`${srvFiles.url}api/scan/files`)).json();
    assert.equal(counts[hash], 1);

    const dl = await fetch(`${srvFiles.url}files/${hash}/${file.file}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'application/pdf');
    assert.match(dl.headers.get('content-disposition'), /^inline/);
    assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), body.toString());

    const del = await fetch(`${srvFiles.url}api/scan/files/${hash}/${file.file}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual(await (await fetch(`${srvFiles.url}api/scan/files/${hash}`)).json(), { hash, files: [] });
    assert.equal((await fetch(`${srvFiles.url}files/${hash}/${file.file}`)).status, 404);
  });

  it('takes uploads for a manual project hash too', async () => {
    const projectHash = 'ab'.repeat(32);
    await fetch(`${srvFiles.url}api/scan/files/${projectHash}?name=grundriss.pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('plan'),
    });
    const { files } = await (await fetch(`${srvFiles.url}api/scan/files/${projectHash}`)).json();
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'grundriss.pdf');
  });

  it('404s uploads for a path-traversal file name and rejects DELETE of unknown files', async () => {
    assert.equal((await fetch(`${srvFiles.url}files/${hash}/..%2f..%2fhomelander.db`)).status, 404);
    assert.equal((await fetch(`${srvFiles.url}files/${hash}/files.json`)).status, 404);
    assert.equal(
      (await fetch(`${srvFiles.url}api/scan/files/${hash}/01-nothere.pdf`, { method: 'DELETE' })).status,
      404
    );
  });

  it('answers 501 for uploads when no data directory is configured', async () => {
    const resp = await fetch(`${srv.url}api/scan/files/${hash}?name=x.pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    assert.equal(resp.status, 501);
  });

  it('serves manual projects with a stable hash and toggleable seen state', async () => {
    writeFileSync(join(dir, 'manual-projects.json'), JSON.stringify([
      { name: 'Testprojekt', address: 'Musterstr. 1, 20095 Hamburg', lat: 53.55, lng: 10.0 },
    ]));
    const srv2 = await startScanServer(() => db, { port: 0, dataDir: dir });
    try {
      let { projects } = await (await fetch(`${srv2.url}api/scan/projects`)).json();
      assert.equal(projects.length, 1);
      const p = projects[0];
      assert.match(p.hash, /^[a-f0-9]{64}$/);
      assert.equal(p.seen, 0);
      assert.equal(p.favorite, 0);

      await fetch(`${srv2.url}api/scan/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: p.hash, favorite: true }),
      });
      ({ projects } = await (await fetch(`${srv2.url}api/scan/projects`)).json());
      assert.equal(projects[0].favorite, 1);

      const resp = await fetch(`${srv2.url}api/scan/seen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: p.hash, seen: true }),
      });
      assert.equal(resp.status, 200);

      ({ projects } = await (await fetch(`${srv2.url}api/scan/projects`)).json());
      assert.equal(projects[0].hash, p.hash);
      assert.equal(projects[0].seen, 1);

      await fetch(`${srv2.url}api/scan/seen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: p.hash, seen: false }),
      });
      ({ projects } = await (await fetch(`${srv2.url}api/scan/projects`)).json());
      assert.equal(projects[0].seen, 0);
    } finally {
      await srv2.close();
    }
  });
});
