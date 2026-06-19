// Add Search dialog — paste IS24 URL, test it, save.

import React, { useState } from 'react';

export default function AddSearchDialog({ onCancel, onAdd }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState(null);

  const handleTest = async () => {
    if (!url.trim()) return;
    setTesting(true);
    setTestResult(null);
    setTestError(null);

    try {
      if (!window.homelander) {
        setTestError('API bridge not available');
        return;
      }
      const result = await window.homelander.testFilter(url.trim());
      if (result.error) {
        setTestError(result.error);
      } else {
        setTestResult(result.total);
      }
    } catch (err) {
      setTestError(err.message);
    } finally {
      setTesting(false);
    }
  };

  const handleAdd = () => {
    if (!url.trim()) return;
    onAdd(url.trim(), name.trim() || '');
    onCancel();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && url.trim() && testResult !== null) {
      handleAdd();
    }
    if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="card p-6 w-full max-w-lg mx-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold mb-4">Add Search</h2>

        {/* URL input */}
        <label className="block text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>
          Paste your IS24 search URL
        </label>
        <input
          type="url"
          className="input mb-3"
          placeholder="https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?..."
          value={url}
          onChange={(e) => { setUrl(e.target.value); setTestResult(null); setTestError(null); }}
          onKeyDown={handleKeyDown}
          autoFocus
        />

        {/* Name (optional) */}
        <label className="block text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>
          Name (optional)
        </label>
        <input
          type="text"
          className="input mb-4"
          placeholder="e.g. Berlin 2-3 rooms under €1,500"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
        />

        {/* Test result */}
        {testResult !== null && (
          <div className="mb-4 px-3 py-2 rounded-lg flex items-center gap-2" style={{ background: 'var(--bg-secondary)' }}>
            <span style={{ color: 'var(--success)', fontSize: 14 }}>✓</span>
            <span className="text-sm">{testResult.toLocaleString()} results found</span>
          </div>
        )}

        {testError && (
          <div className="mb-4 px-3 py-2 rounded-lg flex items-center gap-2" style={{ background: 'var(--bg-secondary)' }}>
            <span style={{ color: 'var(--danger)', fontSize: 14 }}>✗</span>
            <span className="text-sm" style={{ color: 'var(--danger)' }}>{testError}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 justify-end">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleTest}
            disabled={!url.trim() || testing}
          >
            {testing ? 'Testing...' : 'Test'}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleAdd}
            disabled={!url.trim() || testResult === null}
          >
            Add search
          </button>
        </div>
      </div>
    </div>
  );
}
