// Locale context — provides t() and locale state to all components.
// Persists choice to localStorage, detects browser language on first visit.

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import en from './en.json';
import de from './de.json';

const LOCALES = { en, de };
const STORAGE_KEY = 'homelander-locale';

function detectLocale() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && LOCALES[stored]) return stored;
  } catch {}
  // Detect browser language
  try {
    const lang = navigator.language || '';
    if (lang.startsWith('de')) return 'de';
  } catch {}
  return 'en';
}

const LocaleContext = createContext(null);

export function LocaleProvider({ children, onLocaleReady }) {
  const [locale, setLocaleState] = useState(detectLocale);
  const [chosen, setChosen] = useState(() => {
    try { return !!localStorage.getItem(STORAGE_KEY); } catch { return false; }
  });

  const setLocale = useCallback((l) => {
    if (!LOCALES[l]) return;
    setLocaleState(l);
    setChosen(true);
    try { localStorage.setItem(STORAGE_KEY, l); } catch {}
    document.documentElement.lang = l;
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // Signal to parent that locale is ready (for LanguagePicker in Setup)
  useEffect(() => {
    if (onLocaleReady && chosen) onLocaleReady(locale);
  }, [chosen, locale, onLocaleReady]);

  const t = useCallback((key, fallback) => {
    const current = LOCALES[locale];
    const parts = key.split('.');
    let val = current;
    for (const p of parts) {
      if (val == null) break;
      val = val[p];
    }
    if (val != null) return val;
    // Fallback to English
    let enVal = LOCALES.en;
    for (const p of parts) {
      if (enVal == null) break;
      enVal = enVal[p];
    }
    return enVal != null ? enVal : (fallback || key);
  }, [locale]);

  return React.createElement(LocaleContext.Provider, { value: { locale, setLocale, t, chosen } }, children);
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used within LocaleProvider');
  return ctx;
}
