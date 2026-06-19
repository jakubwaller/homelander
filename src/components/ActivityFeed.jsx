// Activity feed — live-scrolling list of sent/failed listings.
// Each entry is clickable: expands to show detail + IS24 link.

import React, { useState, useCallback, useEffect } from 'react';
import { useStore } from '../stores/appStore';

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatDateTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

export default function ActivityFeed() {
  const activity = useStore((s) => s.activity);
  const [expanded, setExpanded] = useState(new Set());
  const [retrying, setRetrying] = useState(new Set());
  const [copied, setCopied] = useState(null);
  const [requeued, setRequeued] = useState(new Set());

  // Listen for daemon retry_queued events
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.exposeId) {
        setRequeued(prev => new Set(prev).add(e.detail.exposeId));
        setTimeout(() => setRequeued(prev => {
          const next = new Set(prev); next.delete(e.detail.exposeId); return next;
        }), 4000);
      }
    };
    window.addEventListener('homelander:retry-queued', handler);
    return () => window.removeEventListener('homelander:retry-queued', handler);
  }, []);

  const toggle = useCallback((key) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const handleRetry = useCallback(async (exposeId) => {
    if (!window.homelander) return;
    setRetrying(prev => new Set(prev).add(exposeId));
    try {
      await window.homelander.retryListing(exposeId);
      // Show queued feedback immediately (daemon also confirms via event)
      window.dispatchEvent(new CustomEvent('homelander:retry-queued', { detail: { exposeId } }));
    } catch {}
    setTimeout(() => setRetrying(prev => {
      const next = new Set(prev);
      next.delete(exposeId);
      return next;
    }), 2000);
  }, []);

  const handleCopy = useCallback(async (text) => {
    try { await navigator.clipboard.writeText(text); } catch {}
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  }, []);

  if (activity.length === 0) {
    return (
      <div className="py-8 text-center" style={{ color: 'var(--text-muted)' }}>
        <p className="text-sm">No activity yet.</p>
        <p className="text-xs mt-1">Add a search to start finding listings.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {activity.slice(0, 100).map((item, i) => {
        const key = `${item.time}-${i}`;
        const exposeId = item.exposeId || item.expose_id;
        const failureReason = item.failureReason || item.failure_reason || '';
        const isExpanded = expanded.has(key);
        const isSent = item.outcome === 'SENT';
        const isDeactivated = item.outcome === 'DEACTIVATED'
          || failureReason.toLowerCase().includes('deactivated')
          || (item.detail || '').toLowerCase().includes('deactivated');
        const isPremium = (item.detail || '').toLowerCase().includes('premium')
          || (item.detail || '').toLowerCase().includes('suchen+')
          || failureReason.toLowerCase().includes('premium');
        const isCaptcha = (item.detail || '').toLowerCase().includes('captcha')
          || failureReason.toLowerCase().includes('captcha');
        const statusColor = isSent ? 'var(--success)' : isDeactivated ? 'var(--text-muted)' : 'var(--danger)';
        const statusIcon = isSent ? '✓' : isDeactivated ? '⊘' : '✗';
        const outcomeLabel = isSent ? 'Sent' : isDeactivated ? 'Deactivated' : 'Failed';

        return (
          <div
            key={key}
            className="card cursor-pointer select-none"
            onClick={() => toggle(key)}
          >
            {/* Summary row */}
            <div className="flex items-center gap-3 px-3 py-2">
              {/* Status icon */}
              <span className={`flex-shrink-0 w-5 text-center ${isDeactivated ? 'text-base' : 'text-sm'}`} style={{ color: statusColor }}>
                {statusIcon}
              </span>

              {/* Title + address */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {item.title || 'Unknown Listing'}
                  </span>
                  <span className="badge badge-sm text-xs" style={{ background: statusColor + '20', color: statusColor }}>
                    {outcomeLabel}
                  </span>
                  {isDeactivated && (
                    <span className="badge badge-deactivated text-xs">🪦 Deactivated</span>
                  )}
                  {isCaptcha && (
                    <span className="badge badge-captcha text-xs">🔐 Captcha</span>
                  )}
                  {isPremium && (
                    <span className="badge badge-premium text-xs">💎 Premium</span>
                  )}
                </div>
                {item.address && (
                  <p className="text-xs truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {item.address}
                  </p>
                )}
              </div>

              {/* External link */}
              {exposeId && (
                <a
                  href={`https://www.immobilienscout24.de/expose/${exposeId}`}
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

              {/* Retry button (visible on summary row for quick access) */}
              {!isSent && !isDeactivated && exposeId && (
                requeued.has(exposeId) ? (
                  <span className="text-xs flex-shrink-0" style={{ color: 'var(--success)' }}>Re-queued →</span>
                ) : (
                  <button
                    className="btn btn-ghost flex-shrink-0"
                    onClick={(e) => { e.stopPropagation(); handleRetry(exposeId); }}
                    disabled={retrying.has(exposeId)}
                    style={{ color: 'var(--accent)', padding: '2px 6px', fontSize: '20px' }}
                    title="Retry this listing"
                  >
                    {retrying.has(exposeId) ? '⟳' : '⟳'}
                  </button>
                )
              )}

              {/* Time */}
              <span className="text-xs flex-shrink-0 w-12 text-right" style={{ color: 'var(--text-muted)' }}>
                {formatTime(item.time)}
              </span>

              {/* Expand chevron */}
              <span className="text-xs flex-shrink-0 transition-transform" style={{
                color: 'var(--text-muted)',
                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              }}>▶</span>
            </div>

            {/* Expanded detail */}
            {isExpanded && (
              <div className="px-3 pb-3 pt-1 border-t mx-3" style={{ borderColor: 'var(--border)' }}>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs mt-2">
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Status: </span>
                    <span style={{ color: statusColor }} className="font-medium">{outcomeLabel}</span>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Time: </span>
                    <span style={{ color: 'var(--text-secondary)' }}>{formatDateTime(item.time)}</span>
                  </div>

                  {exposeId && (
                    <div className="col-span-2">
                      <span style={{ color: 'var(--text-muted)' }}>Exposé ID: </span>
                      <button
                        className="font-mono"
                        style={{ color: copied === exposeId ? 'var(--success)' : 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        onClick={(e) => { e.stopPropagation(); handleCopy(exposeId); }}
                        title="Click to copy"
                      >
                        {exposeId}
                      </button>
                      <span
                        className="ml-2 text-xs"
                        style={{ color: copied === exposeId ? 'var(--success)' : 'var(--text-muted)', cursor: 'pointer' }}
                        onClick={(e) => { e.stopPropagation(); handleCopy(exposeId); }}
                        title="Click to copy"
                      >
                        {copied === exposeId ? '✓ Copied' : '📋'}
                      </span>
                    </div>
                  )}

                  {item.detail && (
                    <div className="col-span-2 mt-1">
                      <span style={{ color: 'var(--text-muted)' }}>Detail: </span>
                      <p
                        className="mt-0.5 p-2 rounded text-xs whitespace-pre-wrap"
                        style={{
                          background: 'var(--bg-secondary)',
                          color: copied === item.detail ? 'var(--success)' : 'var(--text-secondary)',
                          border: '1px solid var(--border)',
                          cursor: 'pointer',
                        }}
                        onClick={(e) => { e.stopPropagation(); handleCopy(item.detail); }}
                        title="Click to copy"
                      >{item.detail}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
