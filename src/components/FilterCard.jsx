// Filter card — displays an IS24 search with stats, pause/remove controls.
// Also shows a "Poll now" button.

import React, { useState, useEffect } from 'react';
import { useStore } from '../stores/appStore';
import { useLocale } from '../locales/LocaleContext';
import StatusDot from './StatusDot';
import { userErrorText } from '../shared/userErrors';

export default function FilterCard({ filter, onPause, onRemove, onPollNow, pollError }) {
  const { t } = useLocale();
  const stats = useStore((s) => s.stats);
  const [confirming, setConfirming] = useState(false);
  const [polling, setPolling] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [pollMessage, setPollMessage] = useState(null);
  const [tooltip, setTooltip] = useState(null);

  const showTooltip = (text, e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({ text, x: rect.left + rect.width / 2, y: rect.top });
  };
  const hideTooltip = () => setTooltip(null);

  const handleRemove = () => {
    if (confirming) {
      onRemove(filter.id);
      setConfirming(false);
    } else {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
    }
  };

  // Format poll feedback message from result fields
  const pollFeedbackText = (result) => {
    const parts = [];
    const inserted = result.inserted || 0;
    const fetched = result.fetched || 0;

    if (inserted > 0) {
      let msg = t('search.pollAdded', '{{count}} new listings found.').replace('{{count}}', inserted);
      if (result.first_poll_capped) {
        msg += ' ' + t('search.firstPollCapped', '(first {{limit}} of many)').replace('{{limit}}', '10');
      }
      parts.push(msg);
    } else if (fetched > 0) {
      parts.push(t('search.pollAllKnown', '{{count}} fetched, all already known.').replace('{{count}}', fetched));
    } else {
      parts.push(t('search.noNewListings', 'No new listings.'));
    }

    if (result.tauschwohnungen_excluded > 0) {
      parts.push(t('search.tauschExcluded', '{{count}} swap apartments filtered').replace('{{count}}', result.tauschwohnungen_excluded));
    }

    // Duplicate protection suffix
    const protectedCount = result.duplicate_protected || result.messengerPendingRowsProtected || 0;
    if (protectedCount > 0) {
      parts.push(t('search.pollDuplicateProtected', '{{count}} bereits kontaktierte geschützt').replace('{{count}}', protectedCount));
    } else {
      const lastCheck = stats.messengerCheckedAt || result.messengerCheckedAt;
      if (lastCheck) {
        const time = new Date(lastCheck).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        parts.push(t('search.lastProtectionCheck', 'Letzte Prüfung: {{time}}').replace('{{time}}', time));
      }
    }

    return parts.join(' · ');
  };

  // Listen for poll_complete from the daemon (daemon running path)
  useEffect(() => {
    if (!polling) return;
    const handler = (e) => {
      if (e.detail?.filter_id !== filter.id) return;
      const result = e.detail;
      const inserted = result.inserted || 0;
      const type = inserted > 0 ? 'success' : 'muted';
      setPollMessage({ type, text: pollFeedbackText(result) });
      setPolling(false);
    };
    window.addEventListener('homelander:poll-complete', handler);
    return () => window.removeEventListener('homelander:poll-complete', handler);
  }, [polling, filter.id]);

  const handlePollNow = async () => {
    if (!window.homelander || polling) return;
    setPolling(true);
    setPollMessage(null);
    try {
      const result = await (onPollNow ? onPollNow(filter.id) : window.homelander.pollNow(filter.id));
      if (result?.error) {
        setPollMessage({ type: 'error', text: result.error });
        setPolling(false);
      } else if (result?.pending) {
        // Daemon will handle the poll — wait for poll_complete event
        const suffix = pollFeedbackText(result);
        setPollMessage({ type: 'muted', text: suffix ? `${t('search.pollStarted', 'Poll started…')} · ${suffix}` : t('search.pollStarted', 'Poll started…') });
      } else {
        // Main.js direct path — result is synchronous
        const type = (result?.inserted || 0) > 0 ? 'success' : 'muted';
        setPollMessage({ type, text: pollFeedbackText(result) });
        setPolling(false);
      }
    } catch (err) {
      setPollMessage({ type: 'error', text: userErrorText(err.userError || err, { operation: 'poll search' }, t) });
      setPolling(false);
    } finally {
      if (!polling) setTimeout(() => setPollMessage(null), 5000);
    }
  };

  const handleClearQueue = async () => {
    if (!window.homelander?.clearQueue || clearing) return;
    setClearing(true);
    setPollMessage(null);
    try {
      const result = await window.homelander.clearQueue(filter.id);
      if (result?.error || result?.ok === false) {
        setPollMessage({ type: 'error', text: result?.error || t('search.clearQueueFailed', 'Could not clear queue.') });
      } else {
        const cleared = Number.isFinite(result?.cleared) ? result.cleared : (filter.new_count || 0);
        setPollMessage({ type: 'success', text: `${t('search.queueCleared', 'Queue cleared')} (${cleared})` });
      }
    } catch (err) {
      setPollMessage({ type: 'error', text: userErrorText(err.userError || err, { operation: 'clear queue' }, t) });
    } finally {
      setClearing(false);
      setTimeout(() => setPollMessage(null), 5000);
    }
  };

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <StatusDot status={filter.enabled ? 'running' : 'paused'} />
            <h3 className="text-sm font-medium truncate">
              {filter.name || t('search.unnamedSearch', 'Unnamed Search')}
            </h3>
          </div>

          {/* Stats row */}
          <div className="flex gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
            <span>{t('search.today', 'Today')} <strong style={{ color: 'var(--accent)' }}>{filter.processed_count || 0}/{filter.today_total || 0}</strong></span>
            <span>{t('search.total', 'Total')} <strong style={{ color: 'var(--text-secondary)' }}>{filter.processed_all_time || 0}/{filter.total_seen || 0}</strong></span>
            {filter.new_count > 0 && (
              <span className="badge badge-accent">+{filter.new_count} {t('search.pending', 'pending')}</span>
            )}
          </div>

          {/* URL preview */}
          <a
            href="#"
            className="text-xs mt-1 truncate block hover:underline cursor-pointer"
            style={{ color: 'var(--text-muted)', maxWidth: 400 }}
            onClick={(e) => { e.preventDefault(); window.homelander.openExternal(filter.web_url); }}
            title={t('search.openInBrowser', 'Open in browser')}
          >
            {filter.web_url}
          </a>

          {/* Poll error */}
          {pollError && (
            <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>
              ⚠ {pollError}
            </p>
          )}

          {/* Poll status */}
          {pollMessage && (
            <p
              className="text-xs mt-2"
              style={{
                color: pollMessage.type === 'error'
                  ? 'var(--danger)'
                  : pollMessage.type === 'success'
                  ? 'var(--success)'
                  : 'var(--text-muted)',
                fontStyle: pollMessage.type === 'muted' ? 'italic' : undefined,
              }}
            >
              {pollMessage.text}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {!!filter.enabled && (
            <span
              onMouseEnter={(e) => showTooltip(t('search.pollNow', 'Poll now'), e)}
              onMouseLeave={hideTooltip}
            >
              <button
                className="btn btn-ghost text-xs"
                onClick={handlePollNow}
                disabled={polling}
              >
                {polling ? '⏳' : '▶'}
              </button>
            </span>
          )}
          <span
            onMouseEnter={(e) => showTooltip(t('search.clearQueue', 'Clear queue'), e)}
            onMouseLeave={hideTooltip}
          >
            <button
              className="btn btn-ghost text-xs"
              onClick={handleClearQueue}
              disabled={clearing || !(filter.new_count > 0)}
            >
              {clearing ? '⏳' : '🧹'}
            </button>
          </span>
          <span
            onMouseEnter={(e) => showTooltip(filter.enabled ? t('search.pauseTitle', 'Pause') : t('search.resumeTitle', 'Fortsetzen'), e)}
            onMouseLeave={hideTooltip}
          >
            <button
              className="btn btn-ghost text-xs"
              onClick={() => onPause(filter.id, !filter.enabled)}
            >
              {filter.enabled ? '⏸' : '▶'}
            </button>
          </span>
          <span
            onMouseEnter={(e) => showTooltip(confirming ? t('search.confirmTitle', 'Confirm') : t('search.removeTitle', 'Remove'), e)}
            onMouseLeave={hideTooltip}
          >
            <button
              className={`btn text-xs ${confirming ? 'btn-danger' : 'btn-ghost'}`}
              onClick={handleRemove}
            >
              {confirming ? '✓' : '🗑'}
            </button>
          </span>
        </div>
      </div>
      {tooltip && (
        <div
          className="fixed pointer-events-none z-50 px-3 py-1.5 rounded-lg text-xs font-medium shadow-lg"
          style={{
            left: tooltip.x,
            top: tooltip.y - 36,
            transform: 'translateX(-50%)',
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            whiteSpace: 'nowrap',
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
