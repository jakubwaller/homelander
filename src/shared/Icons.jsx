// Platform-consistent SVG icons — replace Unicode glyphs that render at different sizes per OS.

export function FlagDE({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" style={{ flexShrink: 0, borderRadius: 6 }}>
      <rect width="48" height="16" fill="#000"/>
      <rect y="16" width="48" height="16" fill="#DD0000"/>
      <rect y="32" width="48" height="16" fill="#FFCC00"/>
    </svg>
  );
}

export function FlagGB({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 60 30" style={{ flexShrink: 0, borderRadius: 3 }}>
      <rect width="60" height="30" fill="#012169"/>
      <path d="M0 0l60 30M60 0L0 30" stroke="#FFF" strokeWidth="6"/>
      <path d="M0 0l60 30M60 0L0 30" stroke="#C8102E" strokeWidth="3"/>
      <path d="M30 0v30M0 15h60" stroke="#FFF" strokeWidth="10"/>
      <path d="M30 0v30M0 15h60" stroke="#C8102E" strokeWidth="5"/>
    </svg>
  );
}

export function ExternalLinkIcon({ size = 14, color = 'var(--accent)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function RetryIcon({ size = 14, color = 'var(--accent)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M21.5 2v6h-6" />
      <path d="M2.5 22v-6h6" />
      <path d="M2 11.5a10 10 0 0 1 18.8-4.3" />
      <path d="M22 12.5a10 10 0 0 1-18.8 4.2" />
    </svg>
  );
}
