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

function listingBadges(listing) {
  const failureReason = (listing.failure_reason || listing.failureReason || '').toLowerCase();
  const detail = (listing.detail || '').toLowerCase();
  const outcome = listing.outcome || '';
  const badges = [];
  if (outcome === 'DEACTIVATED' || failureReason.includes('deactivated') || detail.includes('deactivated')) badges.push('Deactivated');
  if (failureReason.includes('captcha') || detail.includes('captcha')) badges.push('Captcha');
  if (failureReason.includes('premium') || detail.includes('premium') || detail.includes('suchen+')) badges.push('Premium');
  return badges;
}

// ── Entry Row ────────────────────────────────────────────────────────────────

function HistoryEntry({ listing, isExpanded, onToggle, onRetry, retrying, outcomeFilter }) {
  const [copied, setCopied] = useState(null);
  const [requeued, setRequeued] = useState(false);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.exposeId === listing.expose_id) {
        setRequeued(true);
        setTimeout(() => setRequeued(false), 4000);
      }
    };
    window.addEventListener('homelander:retry-queued', handler);
    return () => window.removeEventListener('homelander:retry-queued', handler);
  }, [listing.expose_id]);

  const outcome = listing.outcome || 'FAILED';

  const isSent = outcome === 'SENT';
  const rawBadges = listingBadges(listing);
  // Use raw badges for outcome classification (must work regardless of active filter)
  const isDeactivated = rawBadges.includes('Deactivated');
  const isDryRun = outcome === 'DRY_RUN';
  const isPremium = rawBadges.includes('Premium');
  const isCaptcha = rawBadges.includes('Captcha');
  // Filtered badges for visual rendering only (suppress the badge matching active filter)
  const showBadges = outcomeFilter
    ? rawBadges.filter(b => b.toUpperCase() !== outcomeFilter.toUpperCase())
    : rawBadges;

  // Icon + color — deactivated is its own outcome, not generic "Failed"
  const statusIcon = isSent ? '✓' : isDeactivated ? '⊘' : isDryRun ? '○' : '✗';
  const statusColor = isSent ? 'var(--success)' : isDeactivated ? 'var(--text-muted)' : isDryRun ? 'var(--text-muted)' : 'var(--danger)';

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
            {showBadges.includes('Deactivated') && (
              <span className="badge badge-deactivated text-xs">🪦 Deactivated</span>
            )}
            {showBadges.includes('Captcha') && (
              <span className="badge badge-captcha text-xs">🔐 Captcha</span>
            )}
            {showBadges.includes('Premium') && (
              <span className="badge badge-premium text-xs">💎 Premium</span>
            )}
          </div>
          {listing.address && (
            <p className="text-xs truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {listing.address}
            </p>
          )}
        </div>

        {/* External link */}
        {listing.expose_id && (
          <a
            href={`https://www.immobilienscout24.de/expose/${listing.expose_id}`}
            target="_blank"
            rel="noreferrer"
            className="flex-shrink-0"
            style={{ color: 'var(--accent)', fontSize: '16px' }}
            onClick={(e) => e.stopPropagation()}
            title="Open on ImmobilienScout24"
          >
            ↗
          </a>
        )}

        {/* Retry button */}
        {!isSent && !isDeactivated && listing.expose_id && onRetry && (
          requeued ? (
            <span className="text-xs flex-shrink-0" style={{ color: 'var(--success)' }}>Re-queued →</span>
          ) : (
            <button
              className="btn btn-ghost flex-shrink-0"
              onClick={(e) => { e.stopPropagation(); onRetry(listing.expose_id); }}
              disabled={retrying?.has(listing.expose_id)}
              style={{ color: 'var(--accent)', padding: '2px 6px', fontSize: '16px' }}
              title="Retry this listing"
            >
              <span style={{ fontSize: '20px' }}>⟳</span>
            </button>
          )
        )}

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
                <button
                  className="font-mono"
                  style={{ color: copied === listing.expose_id ? 'var(--success)' : 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(listing.expose_id).catch(() => {});
                    setCopied(listing.expose_id);
                    setTimeout(() => setCopied(null), 1500);
                  }}
                  title="Click to copy"
                >
                  {listing.expose_id}
                </button>
                <span
                  className="ml-2 text-xs"
                  style={{ color: copied === listing.expose_id ? 'var(--success)' : 'var(--text-muted)', cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(listing.expose_id).catch(() => {});
                    setCopied(listing.expose_id);
                    setTimeout(() => setCopied(null), 1500);
                  }}
                  title="Click to copy"
                >
                  {copied === listing.expose_id ? '✓ Copied' : '📋'}
                </span>
              </div>
            )}

            {listing.detail && (
              <div className="col-span-2 mt-1">
                <span style={{ color: 'var(--text-muted)' }}>Detail: </span>
                <p
                  className="mt-0.5 p-2 rounded text-xs whitespace-pre-wrap"
                  style={{
                    background: 'var(--bg-secondary)',
                    color: copied === listing.detail ? 'var(--success)' : 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(listing.detail).catch(() => {});
                    setCopied(listing.detail);
                    setTimeout(() => setCopied(null), 1500);
                  }}
                  title="Click to copy"
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
  const filters = useStore((state) => state.filters);
  const activeTab = useStore((state) => state.activeTab);

  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [filterId, setFilterId] = useState('');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [allTimeStats, setAllTimeStats] = useState(null);
  const [retrying, setRetrying] = useState(new Set());
  const sentinelRef = useRef(null);
  const fetchListingsRef = useRef(null);

  // ── Load stats (optionally filtered by search) ─────────────────────────────
  const loadStats = useCallback((forFilterId) => {
    if (!window.homelander) return;
    window.homelander.getStats(forFilterId || undefined).then(({ stats, error }) => {
      if (!error && stats) setAllTimeStats(stats);
    }).catch(() => {});
  }, []);

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

  fetchListingsRef.current = fetchListings;

  useEffect(() => {
    if (activeTab === 'history') {
      loadStats(filterId);
      fetchListingsRef.current?.(false);
    }
  }, [activeTab, filterId, loadStats]);

  // Listen for daemon listing events — refresh stats + listings while tab is active.
  useEffect(() => {
    if (!window.homelander) return;
    const unsub = window.homelander.onListing(() => {
      if (activeTab === 'history') {
        loadStats(filterId);
        fetchListingsRef.current?.(false);
      }
    });
    return unsub;
  }, [activeTab, filterId, loadStats]);

  // Reset and reload when filters change
  useEffect(() => {
    setExpandedIds(new Set());
    setListings([]);        // clear old data so badges don't flash during reload
    setOffset(0);
    fetchListings(false);
    loadStats(filterId);
  }, [outcomeFilter, filterId, loadStats]);

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

  const handleRetry = useCallback(async (exposeId) => {
    if (!window.homelander) return;
    setRetrying(prev => new Set(prev).add(exposeId));
    try {
      await window.homelander.retryListing(exposeId);
      window.dispatchEvent(new CustomEvent('homelander:retry-queued', { detail: { exposeId } }));
    } catch {}
    setTimeout(() => setRetrying(prev => {
      const next = new Set(prev); next.delete(exposeId); return next;
    }), 2000);
  }, []);

  // ── Load all-time stats
  const exportCSV = useCallback(async () => {
    if (!window.homelander) return;
    setExporting(true);
    setError(null);
    try {
      const { listings: exportRows, error: apiError } = await window.homelander.getHistory(
        1000000,
        0,
        filterId || null,
        outcomeFilter || null
      );
      if (apiError) throw new Error(apiError);
      const rowsToExport = exportRows || [];
      if (rowsToExport.length === 0) return;

      const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
      const header = 'expose_id,title,address,outcome,badges,detail,sent_at,filter_id';
      const rows = rowsToExport
        .map((l) => {
          const outcome = l.outcome || '';
          const badges = listingBadges(l)
            .filter(b => !outcomeFilter || b.toUpperCase() !== outcomeFilter.toUpperCase())
            .join('; ');
          return [
            l.expose_id || '',
            escapeCsv(l.title),
            escapeCsv(l.address),
            outcome,
            escapeCsv(badges),
            escapeCsv(l.detail),
            l.sent_at || '',
            l.filter_id || '',
          ].join(',');
        })
        .join('\n');

      const csv = header + '\n' + rows;
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);

      const filterName = filterId ? (filters.find((f) => f.id === filterId)?.name || filterId).replace(/[^a-z0-9_-]+/gi, '-') : 'all-searches';
      const outcomeName = outcomeFilter || 'all-outcomes';
      const link = document.createElement('a');
      link.href = url;
      link.download = `homelander-history-${filterName}-${outcomeName}-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'CSV export failed');
    } finally {
      setExporting(false);
    }
  }, [filterId, outcomeFilter, filters]);

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
      {/* Stats label — reflects active search filter */}
      <div className="flex items-center gap-3 mb-3 flex-shrink-0">
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          {filterId ? (filters.find(f => f.id === filterId)?.name || 'Search') : 'All time'}
        </span>
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
                onClick={() => { setListings([]); setOutcomeFilter(o.value); }}
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
          disabled={exporting || (allTimeStats?.total ?? listings.length) === 0}
        >
          {exporting ? 'Exporting…' : '⬇ Export'}
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
                      onRetry={handleRetry}
                      retrying={retrying}
                      outcomeFilter={outcomeFilter}
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
