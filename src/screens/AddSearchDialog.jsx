// Add Search dialog — paste IS24 URL, test it, save.

import React, { useState, useMemo } from 'react';
import { userErrorText } from '../shared/userErrors';
import { useLocale } from '../locales/LocaleContext';

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

/** Compact validation error for the visible dialog; raw details stay in preview metadata. */
function compactValidationError(validation, fallback, t) {
  const unsupported = validation?.unsupportedParams || [];
  if (unsupported.length) {
    const names = [...new Set(unsupported.map(p => p.key))];
    const shown = names.slice(0, 4).join(', ');
    const more = names.length > 4 ? ` +${names.length - 4}` : '';
    return `${t('search.unsupportedFilters', 'Nicht unterstützte Filter')}: ${shown}${more}`;
  }
  return fallback;
}

export default function AddSearchDialog({ onCancel, onAdd }) {
  const { t } = useLocale();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState(null);
  const [validation, setValidation] = useState(null);

  const suggestedName = useMemo(() => deriveName(url), [url]);

  const handleTest = async () => {
    if (!url.trim()) return;
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    setValidation(null);

    try {
      if (!window.homelander) {
        setTestError(userErrorText('Backend unavailable', { code: 'BACKEND_UNAVAILABLE' }, t));
        return;
      }
      const result = await window.homelander.testFilter(url.trim());
      setValidation(result.validation || null);
      if (result.error) {
        setTestError(compactValidationError(result.validation, userErrorText(result.userError || result, { operation: 'search test' }), t));
      } else {
        setTestResult(result.total);
      }
    } catch (err) {
      setTestError(userErrorText(err.userError || err, { operation: 'search test' }, t));
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
          setTestError(userErrorText('Backend unavailable', { code: 'BACKEND_UNAVAILABLE' }, t));
          setTesting(false);
          return;
        }
        const result = await window.homelander.testFilter(url.trim());
        setValidation(result.validation || null);
        if (result.error) {
          setTestError(compactValidationError(result.validation, userErrorText(result.userError || result, { operation: 'search test' }), t));
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
        setTestError(userErrorText(err.userError || err, { operation: 'search test' }, t));
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
        <h2 className="text-base font-semibold mb-4">{t('search.addSearch', 'IS24-Suche hinzufügen')}</h2>

        {/* URL input */}
        <label className="block text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>
          {t('search.pasteUrl', 'Vollständige IS24-Such-URL einfügen')}
        </label>
        <input
          type="url"
          className="input mb-3"
          placeholder="https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?..."
          value={url}
          onChange={(e) => { setUrl(e.target.value); setTestResult(null); setTestError(null); setValidation(null); }}
          onKeyDown={handleKeyDown}
          autoFocus
        />

        {/* Name — optional, auto-generated from URL */}
        <label className="block text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>
          {t('search.name', 'Name')} <span style={{ color: 'var(--text-muted)' }}>— {t('search.autoGeneratedFromUrl', 'automatisch aus URL')}</span>
        </label>
        <input
          type="text"
          className="input mb-4"
          placeholder={suggestedName || t('search.searchPlaceholder', 'z.B. Berlin 2-Zimmer')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
        />

        {/* Parsed preview */}
        {validation?.preview && (
          <div className="mb-4 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
            <div className="text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('search.parsedSearch', 'Gelesene Suche')}</div>
            {validation.preview.location && (
              <div className="text-sm mb-1">📍 {validation.preview.location}</div>
            )}
            <div className="flex flex-col gap-1">
              {(validation.preview.filters || []).map((line) => (
                <div key={line} className="text-sm">{line}</div>
              ))}
            </div>
            {validation.safeIgnoredParams?.length > 0 && (
              <div className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                {t('search.ignoredByMobileApi', '{{count}} Filter von Mobile API ignoriert').replace('{{count}}', validation.safeIgnoredParams.length)}
              </div>
            )}
            {!testError && validation.unsupportedParams?.length > 0 && (
              <div className="text-xs mt-2" style={{ color: 'var(--danger)' }}>
                {t('search.unsupportedFilterCount', '{{count}} nicht unterstützte Filter').replace('{{count}}', validation.unsupportedParams.length)}
              </div>
            )}
          </div>
        )}

        {/* Test result */}
        {testResult !== null && (
          <div className="mb-4 px-3 py-2 rounded-lg flex items-center gap-2" style={{ background: 'var(--bg-secondary)' }}>
            <span style={{ color: 'var(--success)', fontSize: 14 }}>✓</span>
            <span className="text-sm">{t('search.resultsFound', '{{count}} Ergebnisse gefunden').replace('{{count}}', testResult.toLocaleString())}</span>
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
            {t('search.cancel', 'Abbrechen')}
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleTest}
            disabled={!url.trim() || testing}
          >
            {testing ? t('search.testing', 'Prüfe…') : t('search.test', 'Prüfen')}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleAdd}
            disabled={!url.trim() || testing}
          >
            {testing ? t('search.testing', 'Prüfe…') : t('search.addSearchButton', 'Suche hinzufügen')}
          </button>
        </div>
      </div>
    </div>
  );
}
