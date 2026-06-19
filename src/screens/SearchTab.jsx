// SearchTab — manages IS24 searches, stats, live feed, and daemon controls.

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useStore } from '../stores/appStore';
import FilterCard from '../components/FilterCard';
import ActivityFeed from '../components/ActivityFeed';

export default function SearchTab() {
  // ── Store ──────────────────────────────────────────────────────
  const filters = useStore((s) => s.filters);
  const setFilters = useStore((s) => s.setFilters);
  const stats = useStore((s) => s.stats);
  const setStats = useStore((s) => s.setStats);
  const pollErrors = useStore((s) => s.pollErrors);
  const setPollError = useStore((s) => s.setPollError);
  const clearPollError = useStore((s) => s.clearPollError);

  // ── Local state ────────────────────────────────────────────────
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tip, setTip] = useState(null);
  const activeTipTargetRef = useRef(null);

  const hideTip = useCallback(() => {
    activeTipTargetRef.current = null;
    setTip(null);
  }, []);

  const showTip = useCallback((text, e) => {
    if (!text || !e?.currentTarget) {
      hideTip();
      return;
    }
    activeTipTargetRef.current = e.currentTarget;
    setTip({ text, x: e.clientX, y: e.clientY });
  }, [hideTip]);

  const moveTip = useCallback((e) => {
    const target = activeTipTargetRef.current || e?.currentTarget;
    if (!target || !e) return;
    activeTipTargetRef.current = target;
    const rect = target.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      hideTip();
      return;
    }
    setTip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : null);
  }, [hideTip]);

  useEffect(() => {
    if (!tip) return;

    const handleWindowMouseMove = (e) => {
      const target = activeTipTargetRef.current;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        hideTip();
      }
    };

    const handleWindowBlur = () => hideTip();
    const handleWindowScroll = () => hideTip();

    window.addEventListener('mousemove', handleWindowMouseMove, true);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('scroll', handleWindowScroll, true);

    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove, true);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('scroll', handleWindowScroll, true);
    };
  }, [tip, hideTip]);

  const normalizeStats = useCallback((fresh) => {
    if (!fresh) return fresh;
    // getStats() returns all-time counters as { total, seen_unapplied, ... }.
    // The dashboard renders queue-style Processed X/Y, so expose a stable
    // `seen` denominator for both all-time and live daemon/today payloads.
    if (fresh.total != null) {
      return {
        seen: (fresh.total || 0) + (fresh.seen_unapplied || 0),
        sent: fresh.sent || 0,
        failed: fresh.failed || 0,
        deactivated: fresh.deactivated || 0,
        premium: fresh.premium || 0,
        captcha: fresh.captcha || 0,
        seen_unapplied: fresh.seen_unapplied || 0,
        today: fresh.today || 0,
        nextPollAt: fresh.nextPollAt || null,
      };
    }
    return {
      seen: fresh.seen || 0,
      sent: fresh.sent || 0,
      failed: fresh.failed || 0,
      deactivated: fresh.deactivated || 0,
      premium: fresh.premium || 0,
      captcha: fresh.captcha || 0,
      seen_unapplied: fresh.seen_unapplied || 0,
      today: fresh.today || 0,
      nextPollAt: fresh.nextPollAt || null,
    };
  }, []);

  // ── Load filters on mount ──────────────────────────────────────
  const loadFilters = useCallback(async () => {
    if (!window.homelander) return;
    setLoading(true);
    setError(null);
    try {
      const { filters: fresh, error: apiError } = await window.homelander.getFilters();
      if (apiError) {
        setError(apiError);
      } else if (fresh) {
        setFilters(fresh);
        // Clear any stale poll errors when filters load successfully
        for (const f of fresh) {
          clearPollError(f.id);
        }
      }
    } catch (err) {
      setError(err.message || 'Failed to load filters');
    } finally {
      setLoading(false);
    }
  }, [setFilters, clearPollError]);

  useEffect(() => {
    loadFilters();
  }, [loadFilters]);

  // Load today's stats and filters on mount, then every 30s.
  useEffect(() => {
    async function refresh() {
      if (!window.homelander) return;
      const [{ stats: fresh, error: statsErr }, { filters: freshFilters, error: filtErr }] = await Promise.all([
        window.homelander.getTodayStats(),
        window.homelander.getFilters(),
      ]);
      if (!statsErr && fresh) {
        setStats(normalizeStats(fresh));
        for (const f of (freshFilters || filters)) clearPollError(f.id);
      }
      if (!filtErr && freshFilters) setFilters(freshFilters);
    }
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [setStats, setFilters, filters, clearPollError, normalizeStats]);

  // ── Filter actions ─────────────────────────────────────────────
  const handleAddFilter = useCallback(async (webUrl, name) => {
    if (!window.homelander) return;
    try {
      const { filter, error: apiError } = await window.homelander.addFilter(webUrl, name);
      if (apiError) {
        setError(apiError);
        return false;
      }
      if (filter) {
        setFilters([...filters, filter]);
      }
      setShowAddDialog(false);
      setError(null);
      return true;
    } catch (err) {
      setError(err.message || 'Failed to add search');
      return false;
    }
  }, [filters, setFilters]);

  const handlePauseFilter = useCallback(async (id, enable) => {
    if (!window.homelander) return;
    try {
      const { error: apiError } = await window.homelander.updateFilter(id, { enabled: enable });
      if (apiError) {
        setPollError(id, apiError);
        return;
      }
      clearPollError(id);
      // Optimistic update
      setFilters(filters.map((f) =>
        f.id === id ? { ...f, enabled: enable } : f
      ));
    } catch (err) {
      setPollError(id, err.message || 'Failed to update search');
    }
  }, [filters, setFilters, setPollError, clearPollError]);

  const handleRemoveFilter = useCallback(async (id) => {
    if (!window.homelander) return;
    try {
      const { error: apiError } = await window.homelander.removeFilter(id);
      if (apiError) {
        setError(apiError);
        return;
      }
      clearPollError(id);
      setFilters(filters.filter((f) => f.id !== id));
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to remove search');
    }
  }, [filters, setFilters, clearPollError]);

  const handlePollNow = useCallback(async (id) => {
    if (!window.homelander) return { error: 'Homelander API unavailable' };
    try {
      const result = await window.homelander.pollNow(id);
      if (!result?.ok) {
        const msg = result?.error || 'Poll failed';
        setPollError(id, msg);
        return { ...result, error: msg };
      }
      clearPollError(id);
      const [{ filters: freshFilters }, { stats: freshStats }] = await Promise.all([
        window.homelander.getFilters(),
        window.homelander.getTodayStats(),
      ]);
      if (freshFilters) setFilters(freshFilters);
      if (freshStats) setStats(normalizeStats(freshStats));
      return result;
    } catch (err) {
      const msg = err.message || 'Poll failed';
      setPollError(id, msg);
      return { error: msg };
    }
  }, [setFilters, setStats, setPollError, clearPollError, normalizeStats]);

  // ── Countdown for next auto-poll ──────────────────────────────
  const [nextPollCountdown, setNextPollCountdown] = useState('');

  // ── Config-applied flash ─────────────────────────────────────
  useEffect(() => {
    const handler = () => {
      setConfigAppliedFlash(true);
      setTimeout(() => setConfigAppliedFlash(false), 2000);
    };
    window.addEventListener('homelander:config-applied', handler);
    return () => window.removeEventListener('homelander:config-applied', handler);
  }, []);

  useEffect(() => {
    if (!stats.nextPollAt) { setNextPollCountdown(''); return; }
    function tick() {
      const diff = new Date(stats.nextPollAt) - Date.now();
      if (diff <= 0) return setNextPollCountdown('any moment');
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setNextPollCountdown(`${m}m ${s}s`);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [stats.nextPollAt]);

  // ── Stat badge helper ──────────────────────────────────────────
  const StatBadge = ({ label, value, color, tooltip }) => (
    <div
      className="card px-4 py-3 flex items-center gap-3 min-w-0"
      style={{ minWidth: 110 }}
      onMouseEnter={tooltip ? (e) => showTip(tooltip, e) : undefined}
      onMouseMove={tooltip ? moveTip : undefined}
      onMouseLeave={tooltip ? hideTip : undefined}
      onPointerLeave={tooltip ? hideTip : undefined}
    >
      <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span className="text-lg font-semibold" style={{ color: color || 'var(--text-primary)' }}>
        {value ?? 0}
      </span>
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6">
      {/* ── Stats row ──────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap mt-2">
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Today</span>
        <StatBadge label="Processed" value={`${(stats.sent + stats.failed + (stats.deactivated || 0))}/${stats.seen}`} color="var(--accent)" />
        <StatBadge label="Sent" value={stats.sent} color="var(--success)" />
        <StatBadge label="Failed" value={stats.failed} color="var(--danger)" />
        <StatBadge label="Deactivated" value={stats.deactivated || 0} color="var(--text-muted)" tooltip="Listings removed from IS24 before the bot could apply — not failures, just bad timing." />
        <StatBadge label="Premium" value={stats.premium || 0} color="#a855f7" tooltip="Premium listings require MieterPlus/Suchen+ subscription. Buy Suchen+ to avoid these errors." />
        <StatBadge label="Captcha" value={stats.captcha || 0} color="#f59e0b" tooltip="Blocked by captcha — enter your 2captcha API key in Settings to auto-solve." />

        </div>

      {/* ── Error banner ──────────────────────────────────────── */}
      {error && (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
          style={{
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            color: 'var(--danger)',
          }}
        >
          <span>⚠</span>
          <span className="flex-1">{error}</span>
          <button
            className="font-medium hover:underline"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Your searches ─────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
              Your searches
            </h2>
            {nextPollCountdown && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                · Next poll in {nextPollCountdown}
              </span>
            )}
          </div>
          <button
            className="btn btn-primary text-sm"
            onClick={() => setShowAddDialog(true)}
          >
            + Add search
          </button>
        </div>

        {loading && filters.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Loading searches…
            </p>
          </div>
        ) : filters.length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              No searches configured yet.
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Add an IS24 search URL to start auto-applying to new listings.
            </p>
            <button
              className="btn btn-primary mt-4 text-sm"
              onClick={() => setShowAddDialog(true)}
            >
              + Add your first search
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {filters.map((filter) => (
              <FilterCard
                key={filter.id}
                filter={filter}
                onPause={handlePauseFilter}
                onRemove={handleRemoveFilter}
                onPollNow={handlePollNow}
                pollError={pollErrors[filter.id] || null}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Add search dialog ─────────────────────────────────── */}
      {showAddDialog && (
        <LazyAddSearchDialog
          onAdd={handleAddFilter}
          onCancel={() => setShowAddDialog(false)}
        />
      )}

      {/* ── Live feed ─────────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
          Live feed
        </h2>
        <ActivityFeed />
      </section>

      {tip && (
        <div
          className="fixed pointer-events-none z-50 px-3 py-1.5 rounded-lg text-xs font-medium shadow-lg"
          style={{
            left: tip.x + 14,
            top: tip.y - 36,
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            maxWidth: 320,
            whiteSpace: 'normal',
          }}
        >
          {tip.text}
        </div>
      )}

    </div>
  );
}

// ── Lazy dialog loader ──────────────────────────────────────────
// Dynamic import so the dialog bundle is only loaded when needed.
function LazyAddSearchDialog({ onAdd, onCancel }) {
  const [Dialog, setDialog] = useState(null);

  useEffect(() => {
    let cancelled = false;
    import('./AddSearchDialog').then((mod) => {
      if (!cancelled) setDialog(() => mod.default);
    }).catch(() => {
      // Fallback: render inline dialog if the module doesn't exist yet
      if (!cancelled) setDialog(() => InlineAddDialog);
    });
    return () => { cancelled = true; };
  }, []);

  if (!Dialog) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
        <div className="card p-6">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</p>
        </div>
      </div>
    );
  }

  return <Dialog onAdd={onAdd} onCancel={onCancel} />;
}

// ── Inline fallback dialog (used when AddSearchDialog.jsx is missing) ─
function InlineAddDialog({ onAdd, onCancel }) {
  const [webUrl, setWebUrl] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!webUrl.trim()) {
      setLocalError('Please enter an IS24 search URL');
      return;
    }
    setSubmitting(true);
    setLocalError(null);
    try {
      const ok = await onAdd(webUrl.trim(), name.trim() || undefined);
      if (!ok) {
        setLocalError('Failed to add search');
      }
    } catch {
      setLocalError('Failed to add search');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="card p-6 w-full" style={{ maxWidth: 480 }}>
        <h2 className="text-base font-semibold mb-4">Add IS24 Search</h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label
              className="block text-xs mb-1.5 font-medium"
              style={{ color: 'var(--text-secondary)' }}
            >
              Search URL
            </label>
            <input
              className="input"
              type="url"
              placeholder="https://www.immobilienscout24.de/Suche/..."
              value={webUrl}
              onChange={(e) => setWebUrl(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label
              className="block text-xs mb-1.5 font-medium"
              style={{ color: 'var(--text-secondary)' }}
            >
              Name (optional)
            </label>
            <input
              className="input"
              type="text"
              placeholder="e.g. Berlin 2-room"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {localError && (
            <p className="text-xs" style={{ color: 'var(--danger)' }}>
              ⚠ {localError}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 mt-2">
            <button
              type="button"
              className="btn btn-ghost text-sm"
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary text-sm"
              disabled={submitting || !webUrl.trim()}
            >
              {submitting ? 'Adding…' : 'Add search'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
