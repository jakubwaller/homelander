// Activity feed — live-scrolling list of sent/failed listings.
// Each entry is clickable: expands to show detail + IS24 link.

import React, { useState, useCallback } from 'react';
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

function formatPrice(price) {
  if (!price || price === 0) return 'Tausch';
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(price);
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

  const toggle = useCallback((key) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
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
        const isExpanded = expanded.has(key);
        const isSent = item.outcome === 'SENT';
        const isDeactivated = item.outcome === 'DEACTIVATED';
        const isPremium = (item.detail || '').toLowerCase().includes('premium')
          || (item.failureReason || '').toLowerCase().includes('premium');
        const isCaptcha = (item.detail || '').toLowerCase().includes('captcha')
          || (item.failureReason || '').toLowerCase().includes('captcha');
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

              {/* Price */}
              <span className="text-sm flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
                {formatPrice(item.price)}
              </span>

              {/* External link */}
              {item.exposeId && (
                <a
                  href={`https://www.immobilienscout24.de/expose/${item.exposeId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs flex-shrink-0"
                  style={{ color: 'var(--accent)' }}
                  onClick={(e) => e.stopPropagation()}
                  title="Open on ImmobilienScout24"
                >
                  ↗
                </a>
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

                  {item.exposeId && (
                    <div className="col-span-2">
                      <span style={{ color: 'var(--text-muted)' }}>Exposé ID: </span>
                      <span style={{ color: 'var(--text-secondary)' }} className="font-mono">{item.exposeId}</span>
                    </div>
                  )}

                  {item.exposeId && (
                    <div className="col-span-2">
                      <a
                        href={`https://www.immobilienscout24.de/expose/${item.exposeId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-medium"
                        style={{ color: 'var(--accent)' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        ↗ Open on ImmobilienScout24
                      </a>
                    </div>
                  )}

                  {item.detail && (
                    <div className="col-span-2 mt-1">
                      <span style={{ color: 'var(--text-muted)' }}>Detail: </span>
                      <p className="mt-0.5 p-2 rounded text-xs whitespace-pre-wrap" style={{
                        background: 'var(--bg-secondary)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border)',
                      }}>{item.detail}</p>
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
