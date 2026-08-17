// Tests for engine/uploads.js — the Kaufradar attachment store.
// Run: node --test test/uploads.test.js

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_UPLOAD_BYTES, deleteUpload, isValidHash, readUploads,
  saveUpload, serveTypeFor, uploadCounts, uploadPath,
} from '../engine/uploads.js';

const LISTING = 'a1b2c3d4e5f60718';
const PROJECT = 'f'.repeat(64);

let dir;

before(() => { dir = mkdtempSync(join(tmpdir(), 'homelander-uploads-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

describe('uploads', () => {
  it('accepts listing and project hashes, rejects anything else', () => {
    assert.equal(isValidHash(LISTING), true);
    assert.equal(isValidHash(PROJECT), true);
    assert.equal(isValidHash('../../etc'), false);
    assert.equal(isValidHash('ABCDEF12'), false);
    assert.equal(isValidHash('abc'), false);
    assert.equal(isValidHash(''), false);
  });

  it('stores a file and lists it back', () => {
    const entry = saveUpload(dir, LISTING, 'Preisliste.pdf', Buffer.from('%PDF-1.4 fake'));
    assert.equal(entry.name, 'Preisliste.pdf');
    assert.equal(entry.size, 13);
    assert.match(entry.file, /^01-Preisliste\.pdf$/);

    const files = readUploads(dir, LISTING);
    assert.equal(files.length, 1);
    assert.equal(files[0].file, entry.file);
    assert.ok(existsSync(uploadPath(dir, LISTING, entry.file)));
  });

  it('keeps both files when the same name is uploaded twice', () => {
    const a = saveUpload(dir, PROJECT, 'expose.pdf', Buffer.from('one'));
    const b = saveUpload(dir, PROJECT, 'expose.pdf', Buffer.from('two'));
    assert.notEqual(a.file, b.file);
    assert.equal(readUploads(dir, PROJECT).length, 2);
  });

  it('sanitises names with paths, spaces and umlauts but keeps the display name', () => {
    const entry = saveUpload(dir, PROJECT, '../../Grundriss Wohnung Ä.pdf', Buffer.from('x'));
    assert.match(entry.file, /^\d\d-[A-Za-z0-9._-]+$/);
    assert.equal(entry.file.includes('/'), false);
    assert.equal(entry.file.includes('..'), false);
    assert.equal(entry.name, 'Grundriss Wohnung Ä.pdf');
  });

  it('refuses empty, oversized and bad-hash uploads', () => {
    assert.throws(() => saveUpload(dir, LISTING, 'x.pdf', Buffer.alloc(0)), /empty/);
    assert.throws(() => saveUpload(dir, LISTING, 'x.pdf', Buffer.alloc(MAX_UPLOAD_BYTES + 1)), /too large/);
    assert.throws(() => saveUpload(dir, 'nope', 'x.pdf', Buffer.from('x')), /bad hash/);
  });

  it('resolves only files that are in the manifest', () => {
    assert.equal(uploadPath(dir, LISTING, '01-Preisliste.pdf') !== null, true);
    assert.equal(uploadPath(dir, LISTING, 'files.json'), null);
    assert.equal(uploadPath(dir, LISTING, 'nothere.pdf'), null);
    assert.equal(uploadPath(dir, 'bad', '01-Preisliste.pdf'), null);
  });

  it('counts attachments per entry', () => {
    const counts = uploadCounts(dir);
    assert.equal(counts[LISTING], 1);
    assert.equal(counts[PROJECT], 3);
  });

  it('deletes a file from disk and manifest', () => {
    const path = uploadPath(dir, LISTING, '01-Preisliste.pdf');
    assert.equal(deleteUpload(dir, LISTING, '01-Preisliste.pdf'), true);
    assert.equal(existsSync(path), false);
    assert.equal(readUploads(dir, LISTING).length, 0);
    assert.equal(deleteUpload(dir, LISTING, '01-Preisliste.pdf'), false);
  });

  it('returns an empty list for unknown entries and no data dir', () => {
    assert.deepEqual(readUploads(dir, '0123456789abcdef'), []);
    assert.deepEqual(readUploads(null, LISTING), []);
    assert.deepEqual(uploadCounts(null), {});
  });

  it('serves known types inline and everything else as a download', () => {
    assert.deepEqual(serveTypeFor('01-x.pdf'), { type: 'application/pdf', inline: true });
    assert.deepEqual(serveTypeFor('01-x.PNG'), { type: 'image/png', inline: true });
    // HTML and SVG must never run on the Kaufradar's own origin.
    assert.deepEqual(serveTypeFor('01-x.html'), { type: 'application/octet-stream', inline: false });
    assert.deepEqual(serveTypeFor('01-x.svg'), { type: 'application/octet-stream', inline: false });
    assert.deepEqual(serveTypeFor('01-x.xlsx'), { type: 'application/octet-stream', inline: false });
  });
});
