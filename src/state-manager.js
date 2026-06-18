// State manager — tracks which listings have been seen/sent to prevent duplicates.
// State file: JSON with { seen_ids: string[], sent_at: Record<string, number> }
// Atomic writes via temp file + rename.

import { readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export class StateManager {
  /**
   * @param {string} statePath  absolute path to state JSON file
   */
  constructor(statePath) {
    this.statePath = statePath;
  }

  /** Load state from disk. Returns a fresh state if file doesn't exist. */
  load() {
    try {
      const raw = readFileSync(this.statePath, 'utf8');
      const data = JSON.parse(raw);
      data.seen_ids = data.seen_ids || [];
      data.sent_at = data.sent_at || {};
      return data;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { seen_ids: [], sent_at: {} };
      }
      throw err;
    }
  }

  /** Atomically write state to disk. */
  save(state) {
    const tmpPath = join(dirname(this.statePath), `.autoapply_state_${randomUUID()}`);
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmpPath, this.statePath);
  }

  /**
   * Diff a list of listings against seen_ids, returning only genuinely new ones.
   * @param {Array<{id: string}>} listings
   * @param {{ seen_ids: string[] }} state
   * @returns {Array<{id: string}>}
   */
  findNew(listings, state) {
    const seen = new Set(state.seen_ids);
    return listings.filter((l) => !seen.has(l.id));
  }

  /** Mark a listing as seen (and optionally sent). */
  markSeen(state, listingId) {
    if (!state.seen_ids.includes(listingId)) {
      state.seen_ids.push(listingId);
    }
  }

  /** Record a sent timestamp for a listing. */
  markSent(state, listingId) {
    this.markSeen(state, listingId);
    state.sent_at[listingId] = Date.now() / 1000;
  }
}
