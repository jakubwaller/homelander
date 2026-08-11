import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toLines, readTransitLines } from '../engine/transit.js';

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
