// Shared read-only DB connection for Electron main process IPC handlers.
// The daemon owns its own connection (separate process); this is for
// renderer queries only — eliminates per-call open/close churn and leaks.

import { HomelanderDB } from '../engine/db.js';

let _db = null;

/** Return the single shared read connection, creating it lazily. */
export function db() {
  return (_db ??= new HomelanderDB(DB_PATH));
}

/** Open the shared connection (call once at app startup). */
export function openSharedDb(dbPath) {
  DB_PATH = dbPath;
  return db();
}

/** Close the shared connection (call on app quit). */
export function closeSharedDb() {
  if (_db) {
    try { _db.close(); } catch (err) { /* best-effort */ }
    _db = null;
  }
}

// Internal — set by openSharedDb
let DB_PATH = null;
