// LanguagePicker — full-screen language selection shown before any other UI.
// Two large side-by-side cards with SVG flags.

import React, { useState } from 'react';
import { useLocale } from '../locales/LocaleContext';
import { FlagDE, FlagGB } from '../shared/Icons';

export default function LanguagePicker() {
  const { setLocale, t } = useLocale();
  const [hovered, setHovered] = useState(null);

  const pick = (lang) => {
    setLocale(lang);
  };

  const cardStyle = (lang) => ({
    width: 200,
    height: 240,
    borderRadius: 12,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    background: hovered === lang ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
    border: hovered === lang ? '1px solid rgba(255,255,255,0.15)' : '1px solid rgba(255,255,255,0.06)',
    transform: hovered === lang ? 'scale(1.03)' : 'scale(1)',
    transition: 'all 0.2s ease',
    outline: 'none',
  });

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg-primary, #0d1117)',
      zIndex: 100,
    }}>
      <h2 style={{
        fontSize: 18,
        fontWeight: 600,
        color: 'var(--text-primary, #e6edf3)',
        marginBottom: 8,
        letterSpacing: '0.03em',
      }}>
        {t('setup.languageDesc', 'Choose your language')}
      </h2>

      <div style={{ display: 'flex', gap: 24, marginTop: 24 }}>
        {/* German */}
        <button
          onClick={() => pick('de')}
          onMouseEnter={() => setHovered('de')}
          onMouseLeave={() => setHovered(null)}
          aria-label="Deutsch"
          style={cardStyle('de')}
        >
          <FlagDE size={56} />
          <span style={{
            fontSize: 20,
            fontWeight: 500,
            color: 'var(--text-primary, #e6edf3)',
          }}>
            {t('setup.german', 'Deutsch')}
          </span>
        </button>

        {/* English */}
        <button
          onClick={() => pick('en')}
          onMouseEnter={() => setHovered('en')}
          onMouseLeave={() => setHovered(null)}
          aria-label="English"
          style={cardStyle('en')}
        >
          <FlagGB size={56} />
          <span style={{
            fontSize: 20,
            fontWeight: 500,
            color: 'var(--text-primary, #e6edf3)',
          }}>
            {t('setup.english', 'English')}
          </span>
        </button>
      </div>

      <p style={{
        fontSize: 11,
        color: 'var(--text-muted, #8b949e)',
        marginTop: 28,
      }}>
        {t('setup.changeLater', 'You can change this later in Settings')}
      </p>
    </div>
  );
}
