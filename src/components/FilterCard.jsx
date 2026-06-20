// Filter card — displays an IS24 search with stats, pause/remove controls.
// Also shows a "Poll now" button.

import React, { useState } from 'react';
import { useLocale } from '../locales/LocaleContext';
import StatusDot from './StatusDot';
import { userErrorText } from '../shared/userErrors';

export default function FilterCard({ filter, onPause, onRemove, onPollNow, pollError }) {
  const { t } = useLocale();
  const [confirming, setConfirming] = useState(false);
  const [polling, setPolling] = useState(false);
  const [pollMessage, setPollMessage] = useState(null);

  const handleRemove = () => {
    if (confirming) {
      onRemove(filter.id);
      setConfirming(false);
    } else {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
    }
  };

  const handlePollNow = async () => {
    if (!window.homelander || polling) return;
    setPolling(true);
    setPollMessage(null);
    try {
      const result = await (onPollNow ? onPollNow(filter.id) : window.homelander.pollNow(filter.id));
      if (result?.error) {
        setPollMessage({ type: 'error', text: result.error });
      } else if ((result?.inserted || 0) > 0) {
        setPollMessage({ type: 'success', text: t('search.pollAdded', '{{count}} neue Inserate gefunden.').replace('{{count}}', result.inserted) });
      } else {
        setPollMessage({ type: 'muted', text: t('search.noNewListings', 'Keine neuen Inserate.') });
      }
    } catch (err) {
      setPollMessage({ type: 'error', text: userErrorText(err.userError || err, { operation: 'poll search' }) });
    } finally {
      setPolling(false);
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
            <span>{t('search.processed', 'Processed')} <strong style={{ color: 'var(--accent)' }}>{filter.processed_count || 0}/{filter.total_seen || 0}</strong></span>
            {filter.new_count > 0 && (
              <span className="badge badge-accent">+{filter.new_count} {t('search.pending', 'pending')}</span>
            )}
          </div>

          {/* URL preview */}
          <p className="text-xs mt-1 truncate" style={{ color: 'var(--text-muted)', maxWidth: 400 }}>
            {filter.web_url}
          </p>

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
            <button
              className="btn btn-ghost text-xs"
              onClick={handlePollNow}
              disabled={polling}
            >
              {polling ? '⏳' : '▶'} {t('search.pollNow', 'Poll now')}
            </button>
          )}
          <button
            className="btn btn-ghost text-xs"
            onClick={() => onPause(filter.id, !filter.enabled)}
          >
            {filter.enabled ? t('search.pause', '⏸ Pause') : t('search.resume', '▶ Resume')}
          </button>
          <button
            className={`btn text-xs ${confirming ? 'btn-danger' : 'btn-ghost'}`}
            onClick={handleRemove}
          >
            {confirming ? t('search.confirm', 'Confirm?') : '🗑'}
          </button>
        </div>
      </div>
    </div>
  );
}
