import { useRef } from 'react';

// Platform-consistent SVG icons — replace Unicode glyphs that render at different sizes per OS.

export function FlagDE({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 32" style={{ flexShrink: 0, borderRadius: 4 }}>
      <rect width="48" height="10.67" fill="#000"/>
      <rect y="10.67" width="48" height="10.67" fill="#DD0000"/>
      <rect y="21.33" width="48" height="10.67" fill="#FFCC00"/>
    </svg>
  );
}

let _gbId = 0;

export function FlagGB({ size = 48 }) {
  const id = useRef(`gb-${++_gbId}`).current;
  return (
    <svg width={size} height={size} viewBox="0 0 48 32" style={{ flexShrink: 0, borderRadius: 4 }}>
      <clipPath id={`${id}-s`}>
        <path d="M0,0 v32 h48 v-32 z"/>
      </clipPath>
      <clipPath id={`${id}-t`}>
        <path d="M24,16 h24 v16 z v16 h-24 z h-24 v-16 z v-16 h24 z"/>
      </clipPath>
      <g clipPath={`url(#${id}-s)`}>
        <path d="M0,0 v32 h48 v-32 z" fill="#012169"/>
        <path d="M0,0 L48,32 M48,0 L0,32" stroke="#fff" strokeWidth="6"/>
        <path d="M0,0 L48,32 M48,0 L0,32" clipPath={`url(#${id}-t)`} stroke="#C8102E" strokeWidth="4"/>
        <path d="M24,0 v32 M0,16 h48" stroke="#fff" strokeWidth="10"/>
        <path d="M24,0 v32 M0,16 h48" stroke="#C8102E" strokeWidth="6"/>
      </g>
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
