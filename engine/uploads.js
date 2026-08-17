// User-uploaded documents for Kaufradar entries.
//
// Exposés, price lists and Grundriss PDFs arrive by mail or from a project's
// own website — nothing the scanner can fetch. They live next to the archived
// media, in <data dir>/uploads/<hash>/, with a files.json manifest per entry.
//
// The hash is the same key the scan_seen / scan_favorite tables use: a 16-hex
// listing hash or the 64-hex sha256('project|<name>') of a manual Neubau pin,
// so a project and a portal listing take attachments the same way.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Per file. Big enough for a scanned exposé, small enough to stay in memory. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const MANIFEST = 'files.json';

/** Served with their real type and inline; everything else downloads as a blob.
 *  HTML/SVG stay off this list on purpose — inline they would run script on
 *  the Kaufradar's own origin. */
const INLINE_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain; charset=utf-8',
};

export function isValidHash(hash) {
  return /^[a-f0-9]{8,64}$/.test(String(hash || ''));
}

export function uploadsRoot(dataDir) {
  return join(dataDir, 'uploads');
}

function entryDir(dataDir, hash) {
  return join(uploadsRoot(dataDir), hash);
}

/** Filesystem-safe, collision-free name. The display name lives in the
 *  manifest, so mangling here costs nothing. */
function safeName(name) {
  const cleaned = String(name || '')
    .split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-80);
  return cleaned || 'datei';
}

/** {file: 'application/pdf', inline: true} — what to answer a GET with. */
export function serveTypeFor(file) {
  const ext = String(file).split('.').pop().toLowerCase();
  const type = INLINE_TYPES[ext];
  return type
    ? { type, inline: true }
    : { type: 'application/octet-stream', inline: false };
}

/** Manifest for one entry — [] when nothing was ever uploaded. */
export function readUploads(dataDir, hash) {
  if (!dataDir || !isValidHash(hash)) return [];
  try {
    const parsed = JSON.parse(readFileSync(join(entryDir(dataDir, hash), MANIFEST), 'utf8'));
    return Array.isArray(parsed.files) ? parsed.files : [];
  } catch {
    return [];
  }
}

function writeManifest(dataDir, hash, files) {
  writeFileSync(
    join(entryDir(dataDir, hash), MANIFEST),
    JSON.stringify({ updated_at: new Date().toISOString(), files }, null, 2)
  );
}

/**
 * Store one uploaded file. Returns the manifest entry.
 * @throws when the hash is malformed or the buffer exceeds MAX_UPLOAD_BYTES.
 */
export function saveUpload(dataDir, hash, name, buffer) {
  if (!dataDir) throw new Error('no data directory');
  if (!isValidHash(hash)) throw new Error('bad hash');
  if (!buffer || !buffer.length) throw new Error('empty file');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('file too large');

  const dir = entryDir(dataDir, hash);
  mkdirSync(dir, { recursive: true });
  const files = readUploads(dataDir, hash);
  const base = safeName(name);
  // Numeric prefix: two uploads of "preisliste.pdf" must both survive.
  let n = files.length + 1;
  while (existsSync(join(dir, `${String(n).padStart(2, '0')}-${base}`))) n++;
  const file = `${String(n).padStart(2, '0')}-${base}`;

  writeFileSync(join(dir, file), buffer);
  const entry = {
    file,
    name: String(name || base).split(/[\\/]/).pop().slice(-160) || base,
    size: buffer.length,
    uploaded_at: new Date().toISOString(),
  };
  writeManifest(dataDir, hash, [...files, entry]);
  return entry;
}

/** Remove one file. Returns true when it was in the manifest. */
export function deleteUpload(dataDir, hash, file) {
  if (!dataDir || !isValidHash(hash)) return false;
  const files = readUploads(dataDir, hash);
  const entry = files.find(f => f.file === file);
  if (!entry) return false;
  rmSync(join(entryDir(dataDir, hash), entry.file), { force: true });
  writeManifest(dataDir, hash, files.filter(f => f !== entry));
  return true;
}

/** Absolute path of a stored file, or null when it isn't in the manifest.
 *  Manifest membership is the authorisation — a name that walked out of the
 *  directory was never written into it. */
export function uploadPath(dataDir, hash, file) {
  if (!dataDir || !isValidHash(hash)) return null;
  const entry = readUploads(dataDir, hash).find(f => f.file === file);
  if (!entry) return null;
  const path = join(entryDir(dataDir, hash), entry.file);
  return existsSync(path) ? path : null;
}

/** {hash: count} across all entries — lets the list badge attachments without
 *  one request per card. */
export function uploadCounts(dataDir) {
  const counts = {};
  if (!dataDir) return counts;
  let dirs = [];
  try {
    dirs = readdirSync(uploadsRoot(dataDir), { withFileTypes: true });
  } catch {
    return counts;
  }
  for (const d of dirs) {
    if (!d.isDirectory() || !isValidHash(d.name)) continue;
    const n = readUploads(dataDir, d.name).length;
    if (n) counts[d.name] = n;
  }
  return counts;
}
