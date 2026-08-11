// Kaufradar — local web view for scan-mode listings.
//
// A tiny dependency-free HTTP server bound to 127.0.0.1 that serves a
// single-page browser UI (list + filters + map) backed by the SQLite DB.
// Started by the Electron main process; the daemon writes the data.

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';
import { renderScanPage } from './scan-page.js';
import { readTransitLines } from './transit.js';

const DEFAULT_PORT = 8477;

/** Hand-maintained off-portal Neubau projects, dropped into the data dir. */
function readManualProjects(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, 'manual-projects.json'), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(p => p && p.name) : [];
  } catch {
    return [];
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function parseListingRow(row) {
  let details = null;
  try { details = row.scan_json ? JSON.parse(row.scan_json) : null; } catch { /* keep null */ }
  const { scan_json, ...rest } = row;
  return { ...rest, details };
}

/**
 * Start the Kaufradar server.
 * @param {() => import('./db.js').HomelanderDB} dbGetter  lazy DB accessor
 * @param {{ port?: number, host?: string, dataDir?: string }} options
 *   dataDir enables /api/scan/transit and /api/scan/projects (both empty
 *   without it).
 * @returns {Promise<{ server, port, url, close }>}
 */
export function startScanServer(dbGetter, { port = DEFAULT_PORT, host = '127.0.0.1', dataDir = null } = {}) {
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, `http://${host}`);
      const path = url.pathname;

      if (req.method === 'POST' && path === '/api/scan/seen') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
          try {
            const { hash, seen } = JSON.parse(body || '{}');
            if (!/^[a-f0-9]+$/.test(String(hash))) return json(res, 400, { error: 'bad hash' });
            dbGetter().setListingSeen(hash, !!seen);
            return json(res, 200, { hash, seen: !!seen });
          } catch (err) {
            return json(res, 400, { error: err.message });
          }
        });
        return;
      }

      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

      const mediaApi = path.match(/^\/api\/scan\/media\/([a-f0-9]+)$/);
      if (mediaApi) {
        if (!dataDir) return json(res, 200, { files: [] });
        try {
          const manifest = JSON.parse(readFileSync(join(dataDir, 'media', mediaApi[1], 'media.json'), 'utf8'));
          const files = (manifest.files || []).map(f => ({ ...f, url: `/media/${mediaApi[1]}/${f.file}` }));
          return json(res, 200, { saved_at: manifest.saved_at || null, files });
        } catch {
          return json(res, 200, { files: [] });
        }
      }

      const mediaFile = path.match(/^\/media\/([a-f0-9]+)\/([\w][\w.-]*)$/);
      if (mediaFile) {
        const file = dataDir && join(dataDir, 'media', mediaFile[1], mediaFile[2]);
        if (!file || !existsSync(file)) return json(res, 404, { error: 'not found' });
        const type = { webp: 'image/webp', png: 'image/png' }[file.split('.').pop()] || 'image/jpeg';
        // Archived listing media never changes once written.
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' });
        res.end(readFileSync(file));
        return;
      }

      if (path === '/' || path === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(renderScanPage());
        return;
      }

      if (path === '/api/scan/transit') {
        return json(res, 200, dataDir ? readTransitLines(dataDir) : { generated_at: null, lines: [] });
      }

      if (path === '/api/scan/projects') {
        return json(res, 200, { projects: dataDir ? readManualProjects(dataDir) : [] });
      }

      if (path === '/api/scan/filters') {
        return json(res, 200, { filters: dbGetter().getScanFilters() });
      }

      if (path === '/api/scan/listings') {
        const filterId = url.searchParams.get('filter_id') || null;
        const limit = Math.min(10000, parseInt(url.searchParams.get('limit') || '5000', 10) || 5000);
        const listings = dbGetter()
          .getScanListings({ filterId, limit })
          .map(parseListingRow);
        return json(res, 200, { generated_at: new Date().toISOString(), count: listings.length, listings });
      }

      const listingMatch = path.match(/^\/api\/scan\/listing\/([a-f0-9]+)$/);
      if (listingMatch) {
        const row = dbGetter().db
          .prepare('SELECT l.*, f.name AS filter_name FROM listings l LEFT JOIN filters f ON f.id = l.filter_id WHERE l.hash = ?')
          .get(listingMatch[1]);
        if (!row) return json(res, 404, { error: 'not found' });
        return json(res, 200, { listing: parseListingRow(row) });
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryListen = (p) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts < 10) {
          attempts++;
          tryListen(p + 1);
        } else {
          reject(err);
        }
      });
      server.listen(p, host, () => {
        server.removeAllListeners('error');
        const actualPort = server.address().port;
        resolve({
          server,
          port: actualPort,
          url: `http://${host}:${actualPort}/`,
          close: () => new Promise((r) => server.close(r)),
        });
      });
    };
    tryListen(port);
  });
}
