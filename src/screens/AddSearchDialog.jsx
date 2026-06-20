// Add Search dialog — paste IS24 URL, test it, save.

import React, { useState, useMemo } from 'react';
import { userErrorText } from '../shared/userErrors';

/** Derive a human-readable name from an IS24 search URL. */
function deriveName(url) {
  try {
    // Add https:// if missing — new URL() requires absolute URL
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const u = new URL(url);
    if (!u.hostname.includes('immobilienscout24')) return '';
    const parts = u.pathname.split('/').filter(Boolean);
    // Path: /Suche/de/{state?}/{city}/{type}
    const sucheIdx = parts.findIndex(p => p.toLowerCase() === 'suche');
    if (sucheIdx < 0) return '';
    // The type is the last segment (ends with -mieten, -kaufen, etc.)
    const rawType = parts[parts.length - 1] || '';
    // City is the segment before the type
    const city = parts[parts.length - 2] || '';
    const cityName = city.charAt(0).toUpperCase() + city.slice(1).replace(/-/g, ' ');
    const typeName = rawType.replace(/-/g, ' ').replace(/mieten/, 'zur Miete').replace(/kaufen/, 'zum Kauf');
    if (!cityName && !typeName) return '';
    if (!typeName) return cityName;
    return `${cityName} · ${typeName}`;
  } catch {
    return '';
  }
}

export default function AddSearchDialog({ onCancel, onAdd }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState(null);

  const suggestedName = useMemo(() => deriveName(url), [url]);

  const handleTest = async () => {
    if (!url.trim()) return;
    setTesting(true);
    setTestResult(null);
    setTestError(null);

    try {
      if (!window.homelander) {
        setTestError(userErrorText('Backend unavailable', { code: 'BACKEND_UNAVAILABLE' }));
        return;
      }
      const result = await window.homelander.testFilter(url.trim());
      if (result.error) {
        setTestError(userErrorText(result.userError || result, { operation: 'search test' }));
      } else {
        setTestResult(result.total);
      }
    } catch (err) {
      setTestError(userErrorText(err.userError || err, { operation: 'search test' }));
    } finally {
      setTesting(false);
    }
  };

  const handleAdd = async () => {
    if (!url.trim()) return;

    // Auto-test first if not yet tested
    if (testResult === null && !testing) {
      setTesting(true);
      setTestError(null);
      try {
        if (!window.homelander) {
          setTestError(userErrorText('Backend unavailable', { code: 'BACKEND_UNAVAILABLE' }));
          setTesting(false);
          return;
        }
        const result = await window.homelander.testFilter(url.trim());
        if (result.error) {
          setTestError(userErrorText(result.userError || result, { operation: 'search test' }));
          setTesting(false);
          return;
        }
        setTestResult(result.total);
        setTesting(false);
        // Now add with the result
        const finalName = name.trim() || suggestedName;
        onAdd(url.trim(), finalName);
        onCancel();
        return;
      } catch (err) {
        setTestError(userErrorText(err.userError || err, { operation: 'search test' }));
        setTesting(false);
        return;
      }
    }

    if (testResult === null) return;
    const finalName = name.trim() || suggestedName;
    onAdd(url.trim(), finalName);
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

        {/* Name — optional, auto-generated from URL */}
        <label className="block text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>
          Name <span style={{ color: 'var(--text-muted)' }}>— auto-generated from URL</span>
        </label>
        <input
          type="text"
          className="input mb-4"
          placeholder={suggestedName || 'e.g. Berlin 2-3 rooms under €1,500'}
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
            disabled={!url.trim() || testing}
          >
            {testing ? 'Testing...' : 'Add search'}
          </button>
        </div>
      </div>
    </div>
  );
}
