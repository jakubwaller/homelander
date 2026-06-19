// Status dot — green (running), yellow (paused), red (stopped/error).

import React from 'react';

export default function StatusDot({ status }) {
  const cls = status === 'running' ? 'active' : status === 'paused' ? 'paused' : 'error';
  return <span className={`status-dot ${cls}`} />;
}
