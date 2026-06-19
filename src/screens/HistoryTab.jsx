// HistoryTab — chronological log of sent/failed listings.
// Filterable by outcome and search, grouped by date, with CSV export.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../stores/appStore';

const PAGE_SIZE = 30;
const OUTCOME_KEYS = [
  { value: '', label: 'All', statKey: 'total', icon: null, color: null },
  { value: 'SENT', label: 'Sent', statKey: 'sent', icon: '●', color: 'var(--success)' },
  { value: 'FAIL', label: 'Failed', statKey: 'failed', icon: '●', color: 'var(--danger)' },
  { value: 'DEACTIVATED', label: 'Deactivated', statKey: 'deactivated', icon: '●', color: 'var(--text-secondary)' },
  { value: 'PREMIUM', label: 'Premium', statKey: 'premium', icon: '●', color: '#a855f7' },
  { value: 'CAPTCHA', label: 'Captcha', statKey: 'captcha', icon: '●', color: '#f59e0b' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';

    return d.toLocaleDateString('de-DE', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

function formatPrice(price) {
  if (!price || price === 0) return 'Tausch';
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(price);
}

function formatDateTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

// ── Entry Row ────────────────────────────────────────────────────────────────

function HistoryEntry({ listing, isExpanded, onToggle }) {
  const outcome = listing.outcome || 'FAILED';

  const isSent = outcome === 'SENT';
  const isDeactivated = outcome === 'DEACTIVATED'
    || (listing.failure_reason || '').includes('DEACTIVATED')
    || (listing.detail || '').includes('DEACTIVATED');
  const isDryRun = outcome === 'DRY_RUN';
  const isPremium =
    (listing.failure_reason || '').toLowerCase().includes('premium') ||
    (listing.detail || '').toLowerCase().includes('premium');
  const isCaptcha =
    (listing.failure_reason || '').toLowerCase().includes('captcha') ||
    (listing.detail || '').toLowerCase().includes('captcha');

  // Icon + color always reflect the true outcome
  const statusIcon = isSent ? '✓' : isDeactivated ? '⊘' : isDryRun ? '○' : '✗';
  const statusColor = isSent ? 'var(--success)' : isDeactivated ? 'var(--text-muted)' : isDryRun ? 'var(--text-muted)' : 'var(--danger)';

  // Outcome label always from the real outcome
  const outcomeLabel = isSent ? 'Sent' : isDeactivated ? 'Deactivated' : isDryRun ? 'Dry Run' : 'Failed';

  const badgeClass = isSent ? 'badge-success' : isDeactivated ? 'badge-deactivated' : isDryRun ? '' : 'badge-fail';

  return (
    <div
      className="card cursor-pointer select-none"
      onClick={() => onToggle(listing.expose_id)}
    >
      {/* Summary row */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        {/* Status icon */}
        <span
          className={`flex-shrink-0 w-5 text-center ${isDeactivated ? 'text-base' : 'text-sm'}`}
          style={{ color: statusColor }}
        >
          {statusIcon}
        </span>

        {/* Title + address */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">
              {listing.title || 'Unknown Listing'}
            </span>
            <span className={`badge ${badgeClass} text-xs`}>
              {outcomeLabel}
            </span>
            {isCaptcha && (
              <span className="badge badge-captcha text-xs">🔐 Captcha</span>
            )}
            {isPremium && (
              <span className="badge badge-premium text-xs">💎 Premium</span>
            )}
          </div>
          {listing.address && (
            <p className="text-xs truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {listing.address}
            </p>
          )}
        </div>

        {/* Price */}
        <span className="text-sm flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
          {formatPrice(listing.price)}
        </span>

        {/* Time */}
        <span className="text-xs flex-shrink-0 w-12 text-right" style={{ color: 'var(--text-muted)' }}>
          {formatTime(listing.sent_at)}
        </span>

        {/* Expand chevron */}
        <span
          className="text-xs flex-shrink-0 transition-transform"
          style={{
            color: 'var(--text-muted)',
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          ▶
        </span>
      </div>

      {/* Expanded detail */}
      {isExpanded && (
        <div
          className="px-3 pb-3 pt-1 border-t mx-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs mt-2">
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Status: </span>
              <span style={{ color: statusColor }} className="font-medium">
                {outcomeLabel}
              </span>
            </div>

            <div>
              <span style={{ color: 'var(--text-muted)' }}>Time: </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                {formatDateTime(listing.sent_at)}
              </span>
            </div>

            {listing.expose_id && (
              <div className="col-span-2">
                <span style={{ color: 'var(--text-muted)' }}>Exposé ID: </span>
                <span style={{ color: 'var(--text-secondary)' }} className="font-mono">
                  {listing.expose_id}
                </span>
              </div>
            )}

            {/* IS24 link */}
            <div className="col-span-2">
              <a
                href={`https://www.immobilienscout24.de/expose/${listing.expose_id}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-medium"
                style={{ color: 'var(--accent)' }}
                onClick={(e) => e.stopPropagation()}
              >
                ↗ Open on ImmobilienScout24
              </a>
            </div>

            {listing.failure_reason && (
              <div className="col-span-2">
                <span style={{ color: 'var(--text-muted)' }}>Failure reason: </span>
                <span style={{ color: 'var(--danger)' }}>{listing.failure_reason}</span>
              </div>
            )}

            {listing.detail && (
              <div className="col-span-2 mt-1">
                <span style={{ color: 'var(--text-muted)' }}>Detail: </span>
                <p
                  className="mt-0.5 p-2 rounded text-xs whitespace-pre-wrap"
                  style={{
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {listing.detail}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function HistoryTab() {
  const filters = useStore((s) => s.filters);
  const activeTab = useStore((s) => s.activeTab);

  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [filterId, setFilterId] = useState('');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [allTimeStats, setAllTimeStats] = useState(null);
  const sentinelRef = useRef(null);

  // ── Load all-time stats (refetch on tab activation) ────────────────────────
  const loadStats = useCallback(() => {
    if (!window.homelander) return;
    window.homelander.getStats().then(({ stats, error }) => {
      if (!error && stats) setAllTimeStats(stats);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (activeTab === 'history') loadStats();
  }, [activeTab, loadStats]);

  // Listen for daemon listing events — refresh stats + listings while tab is active
  const fetchListingsRef = useRef(fetchListings);
  fetchListingsRef.current = fetchListings;

  useEffect(() => {
    if (!window.homelander) return;
    const unsub = window.homelander.onListing(() => {
      if (activeTab === 'history') {
        loadStats();
        fetchListingsRef.current(false);
      }
    });
    return unsub;
  }, [activeTab, loadStats]);

  // ── Fetch listings ───────────────────────────────────────────────────────

  const fetchListings = useCallback(
    async (append = false) => {
      if (!window.homelander) {
        setError('Homelander API unavailable');
        setLoading(false);
        return;
      }

      const currentOffset = append ? offset : 0;

      if (!append) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);

      const { listings: newListings, error: apiError } =
        await window.homelander.getHistory(
          PAGE_SIZE,
          currentOffset,
          filterId || null,
          outcomeFilter || null
        );

      if (apiError) {
        setError(apiError);
        setLoading(false);
        setLoadingMore(false);
        return;
      }

      const items = newListings || [];

      if (append) {
        setListings((prev) => [...prev, ...items]);
        setOffset((prev) => prev + items.length);
      } else {
        setListings(items);
        setOffset(items.length);
      }

      setHasMore(items.length >= PAGE_SIZE);
      setLoading(false);
      setLoadingMore(false);
    },
    [outcomeFilter, filterId, offset]
  );

  // Reset and reload when filters change
  useEffect(() => {
    setExpandedIds(new Set());
    fetchListings(false);
  }, [outcomeFilter, filterId]);

  // ── Infinite scroll (IntersectionObserver) ────────────────────────────────

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
          fetchListings(true);
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, fetchListings]);

  // ── Toggle expand ────────────────────────────────────────────────────────

  const toggleExpand = useCallback((id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // ── Export CSV ───────────────────────────────────────────────────────────

  const exportCSV = useCallback(() => {
    if (listings.length === 0) return;

    const header = 'expose_id,title,price,address,outcome,failure_reason,detail,sent_at';
    const rows = listings
      .map((l) =>
        [
          l.expose_id || '',
          `"${(l.title || '').replace(/"/g, '""')}"`,
          l.price || '',
          `"${(l.address || '').replace(/"/g, '""')}"`,
          l.outcome || '',
          `"${(l.failure_reason || '').replace(/"/g, '""')}"`,
          `"${(l.detail || '').replace(/"/g, '""')}"`,
          l.sent_at || '',
        ].join(',')
      )
      .join('\n');

    const csv = header + '\n' + rows;
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = `homelander-history-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [listings]);

  // ── Group listings by date ────────────────────────────────────────────────

  const grouped = React.useMemo(() => {
    const groups = new Map();
    for (const listing of listings) {
      const dateKey = formatDate(listing.sent_at);
      if (!groups.has(dateKey)) {
        groups.set(dateKey, []);
      }
      groups.get(dateKey).push(listing);
    }
    return groups;
  }, [listings]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* All time label */}
      <div className="flex items-center gap-3 mb-3 flex-shrink-0">
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>All time</span>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-3 flex-shrink-0">
        {/* Outcome filter */}
        <div className="flex gap-1">
          {OUTCOME_KEYS.map((o) => {
            const count = allTimeStats ? allTimeStats[o.statKey] : null;
            const label = count != null ? `${o.label} ${count}` : o.label;
            const isActive = outcomeFilter === o.value;
            return (
              <button
                key={o.value}
              className="btn btn-ghost text-xs px-3 py-1.5 whitespace-nowrap"
              style={
                isActive
                  ? {
                      background: 'var(--accent)',
                      color: 'white',
                    }
                  : o.color
                    ? { color: o.color }
                    : { color: 'var(--accent)' }
              }
              onClick={() => setOutcomeFilter(o.value)}
            >
              {label}
            </button>
          );
          })}
        </div>

        <div className="flex-1" />

        {/* Search filter dropdown */}
        <div className="relative">
          <select
            className="select text-xs py-1.5 px-3"
            style={{ width: 180 }}
            value={filterId}
            onChange={(e) => setFilterId(e.target.value)}
          >
            <option value="">All searches</option>
            {filters.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name || `Search ${f.id}`}
              </option>
            ))}
          </select>
        </div>

        {/* Export button */}
        <button
          className="btn btn-secondary text-xs"
          onClick={exportCSV}
          disabled={listings.length === 0}
        >
          ⬇ Export CSV
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {/* Loading state */}
        {loading && (
          <div className="py-12 text-center" style={{ color: 'var(--text-muted)' }}>
            <p className="text-sm">Loading history…</p>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="py-12 text-center">
            <p className="text-sm" style={{ color: 'var(--danger)' }}>
              ⚠ {error}
            </p>
            <button
              className="btn btn-secondary text-xs mt-3"
              onClick={() => fetchListings(false)}
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && listings.length === 0 && (
          <div className="py-12 text-center" style={{ color: 'var(--text-muted)' }}>
            <p className="text-sm">No history yet.</p>
            <p className="text-xs mt-1">Sent and failed listings will appear here.</p>
          </div>
        )}

        {/* Listings grouped by date */}
        {!loading && !error && listings.length > 0 && (
          <div className="space-y-4">
            {[...grouped.entries()].map(([date, items]) => (
              <div key={date}>
                {/* Date header */}
                <h3
                  className="text-xs font-semibold uppercase tracking-wide mb-2 px-1"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {date}
                </h3>

                {/* Entries for this date */}
                <div className="space-y-1">
                  {items.map((listing) => (
                    <HistoryEntry
                      key={listing.expose_id || listing.sent_at}
                      listing={listing}
                      isExpanded={expandedIds.has(listing.expose_id)}
                      onToggle={toggleExpand}
                    />
                  ))}
                </div>
              </div>
            ))}

            {/* Infinite scroll sentinel */}
            <div ref={sentinelRef} className="h-1" />

            {/* Loading more indicator */}
            {loadingMore && (
              <div className="py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                <p className="text-xs">Loading more…</p>
              </div>
            )}

            {/* End of list */}
            {!hasMore && listings.length > PAGE_SIZE && (
              <div
                className="py-4 text-center text-xs"
                style={{ color: 'var(--text-muted)' }}
              >
                — End of history —
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
