import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  haversineMeters, nearestStation, readTransitLines, readTransitStations,
  toLines, toStations, walkMinutes,
} from '../engine/transit.js';

const way = (id, coords) => ({ type: 'way', ref: id, geometry: coords.map(([lat, lon]) => ({ lat, lon })) });

test('toLines groups both directions of a line by ref and dedupes shared ways', () => {
  const rel = (id, members) => ({
    id, tags: { ref: 'U1', colour: '#0072BC', route: 'subway' }, members,
  });
  const shared = way(10, [[53.55111119, 10.0], [53.552, 10.001]]);
  const lines = toLines([
    rel(1, [shared, way(11, [[53.553, 10.002], [53.554, 10.003]])]),
    rel(2, [shared, way(12, [[53.555, 10.004], [53.556, 10.005]])]),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ref, 'U1');
  assert.equal(lines[0].colour, '#0072BC');
  assert.equal(lines[0].ways.length, 3);
  assert.deepEqual(lines[0].ways[0][0], [53.55111, 10]);
});

test('toLines skips refless relations, node members, and degenerate ways', () => {
  const lines = toLines([
    { id: 1, tags: { colour: '#fff' }, members: [way(1, [[53.5, 10], [53.6, 10]])] },
    { id: 2, tags: { ref: 'S1' }, members: [
      { type: 'node', ref: 5, lat: 53.5, lon: 10 },
      way(2, [[53.5, 10]]),
    ] },
  ]);
  assert.deepEqual(lines, []);
});

test('toLines sorts refs numerically (U2 before U21)', () => {
  const mk = (ref) => ({ id: ref, tags: { ref }, members: [way(ref, [[53.5, 10], [53.6, 10]])] });
  const refs = toLines([mk('U21'), mk('U2'), mk('S3'), mk('S31')]).map(l => l.ref);
  assert.deepEqual(refs, ['S3', 'S31', 'U2', 'U21']);
});

test('readTransitLines returns an empty shape for a missing cache', () => {
  assert.deepEqual(readTransitLines('/nonexistent-dir'), { generated_at: null, lines: [] });
});

test('toStations keeps named route members and dedupes repeated stop positions', () => {
  const stations = toStations([
    { type: 'relation', id: 1, tags: { ref: 'U1' }, members: [] },
    { type: 'node', id: 2, lat: 53.5860001, lon: 9.9770001, tags: { name: 'Kellinghusenstraße' } },
    { type: 'node', id: 3, lat: 53.586, lon: 9.977, tags: { name: 'Kellinghusenstraße' } },
    { type: 'node', id: 4, lat: 53.5875, lon: 9.9782, tags: { name: 'Kellinghusenstraße' } },
    { type: 'node', id: 5, lat: 53.55, lon: 10.0, tags: { railway: 'switch' } },
    { type: 'node', id: 6, lat: 53.5613, lon: 9.9772, tags: { name: 'Eppendorfer Baum' } },
  ]);
  // Same rounded position collapses; a second platform 170 m away is its own entry.
  assert.deepEqual(stations, [
    { name: 'Eppendorfer Baum', lat: 53.5613, lng: 9.9772 },
    { name: 'Kellinghusenstraße', lat: 53.586, lng: 9.977 },
    { name: 'Kellinghusenstraße', lat: 53.5875, lng: 9.9782 },
  ]);
});

test('haversineMeters matches a known Hamburg leg', () => {
  // Kellinghusenstraße → Eppendorfer Baum is ~2.75 km of track, ~2.7 km direct.
  const m = haversineMeters(53.586, 9.977, 53.5613, 9.9772);
  assert.ok(m > 2700 && m < 2760, `expected ~2.7 km, got ${Math.round(m)} m`);
  assert.equal(Math.round(haversineMeters(53.5, 10, 53.5, 10)), 0);
});

test('walkMinutes applies the detour factor — 10 minutes is ~615 m direct', () => {
  assert.equal(Math.round(walkMinutes(615)), 10);
  assert.ok(walkMinutes(615) <= 10);
  assert.ok(walkMinutes(620) > 10);
});

test('nearestStation picks the closest stop and reports minutes', () => {
  const stations = [
    { name: 'Eppendorfer Baum', lat: 53.5613, lng: 9.9772 },
    { name: 'Hoheluftbrücke', lat: 53.5793, lng: 9.9727 },
  ];
  const hit = nearestStation(53.5799, 9.9735, stations);
  assert.equal(hit.name, 'Hoheluftbrücke');
  assert.ok(hit.meters < 100);
  assert.ok(hit.minutes < 2);
});

test('nearestStation returns null without coordinates or stations', () => {
  assert.equal(nearestStation(null, null, [{ name: 'X', lat: 53.5, lng: 10 }]), null);
  assert.equal(nearestStation(53.5, 10, []), null);
});

test('readTransitStations is empty for a cache written before stations existed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'homelander-transit-'));
  try {
    writeFileSync(join(dir, 'transit-lines.json'),
      JSON.stringify({ generated_at: '2026-08-01T00:00:00Z', lines: [{ ref: 'U1', ways: [] }] }));
    assert.deepEqual(readTransitStations(dir).stations, []);
    // ...and the lines endpoint never leaks stations to the map payload.
    writeFileSync(join(dir, 'transit-lines.json'),
      JSON.stringify({ generated_at: 'x', lines: [], stations: [{ name: 'A', lat: 1, lng: 2 }] }));
    assert.deepEqual(Object.keys(readTransitLines(dir)).sort(), ['generated_at', 'lines']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
