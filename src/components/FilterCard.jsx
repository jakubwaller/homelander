// Filter card — displays an IS24 search with stats, pause/remove controls.
// Also shows a "Poll now" button and countdown to next auto-poll.

import React, { useState, useEffect } from 'react';
import StatusDot from './StatusDot';

function useCountdown(targetIso) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!targetIso) return;
    function tick() {
      const diff = new Date(targetIso) - Date.now();
      if (diff <= 0) return setText('any moment');
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setText(`${m}m ${s}s`);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetIso]);
  return text;
}

export default function FilterCard({ filter, onPause, onRemove, onPollNow, pollError, nextPollAt }) {
  const [confirming, setConfirming] = useState(false);
  const [polling, setPolling] = useState(false);
  const countdown = useCountdown(nextPollAt);

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
    try {
      await window.homelander.pollNow(filter.id);
    } catch {}
    setTimeout(() => setPolling(false), 3000);
  };

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <StatusDot status={filter.enabled ? 'running' : 'paused'} />
            <h3 className="text-sm font-medium truncate">
              {filter.name || 'Unnamed Search'}
            </h3>
          </div>

          {/* Stats row */}
          <div className="flex gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
            <span>Processed <strong style={{ color: 'var(--accent)' }}>{filter.processed_count || 0}/{filter.total_seen || 0}</strong></span>
            {filter.new_count > 0 && (
              <span className="badge badge-accent">+{filter.new_count} pending</span>
            )}
            {nextPollAt && filter.enabled && (
              <span style={{ color: 'var(--text-muted)' }}>· Next poll in {countdown}</span>
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
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {filter.enabled && (
            <button
              className="btn btn-ghost text-xs"
              onClick={handlePollNow}
              disabled={polling}
            >
              {polling ? '⏳' : '▶'} Poll now
            </button>
          )}
          <button
            className="btn btn-ghost text-xs"
            onClick={() => onPause(filter.id, !filter.enabled)}
          >
            {filter.enabled ? '⏸ Pause' : '▶ Resume'}
          </button>
          <button
            className={`btn text-xs ${confirming ? 'btn-danger' : 'btn-ghost'}`}
            onClick={handleRemove}
          >
            {confirming ? 'Confirm?' : '🗑'}
          </button>
        </div>
      </div>
    </div>
  );
}
