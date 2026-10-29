import { useId } from 'react';

export default function BossIcon({ bossName, className = 'h-10 w-10' }: { bossName: string; className?: string }) {
  const id = useId().replace(/:/g, '');
  const boss = bossName.trim().toLowerCase();
  const colors = boss === 'base'
    ? { glow: '#a9c0d9', edge: '#dbe8f5', main: '#b8c7d8', dark: '#647b96', accent: '#eaf3fb' }
    : boss === 'prime'
      ? { glow: '#f4c95d', edge: '#ffebad', main: '#dba936', dark: '#8c5d1d', accent: '#fff0a8' }
      : boss === 'bt'
        ? { glow: '#e35658', edge: '#ffd1a4', main: '#bd4b48', dark: '#4b303b', accent: '#b7eb62' }
        : boss === 'gele'
          ? { glow: '#a78bfa', edge: '#e7ddff', main: '#8165c9', dark: '#352c63', accent: '#89f0cb' }
          : boss === 'dino'
            ? { glow: '#62d8ff', edge: '#c4f4ff', main: '#38a9e5', dark: '#20568e', accent: '#a7f1ff' }
            : { glow: '#a78bfa', edge: '#e8e1ff', main: '#777b91', dark: '#252b3b', accent: '#c4b5fd' };
  const metal = `boss-metal-${id}`;

  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={metal} x1="12" y1="8" x2="51" y2="58" gradientUnits="userSpaceOnUse">
          <stop stopColor={colors.edge} />
          <stop offset=".48" stopColor={colors.main} />
          <stop offset="1" stopColor={colors.dark} />
        </linearGradient>
        <radialGradient id={`boss-halo-${id}`} cx="0" cy="0" r="1" gradientTransform="matrix(0 35 -35 0 32 20)" gradientUnits="userSpaceOnUse">
          <stop stopColor={colors.glow} stopOpacity=".34" />
          <stop offset="1" stopColor={colors.glow} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill="#0b1220" />
      <circle cx="32" cy="32" r="29" fill={`url(#boss-halo-${id})`} stroke={colors.glow} strokeOpacity=".42" strokeWidth="1.2" />
      <circle cx="32" cy="32" r="23.5" fill="#111a2a" fillOpacity=".78" stroke={colors.edge} strokeOpacity=".12" />

      {boss === 'base' || boss === 'prime' ? (
        <g stroke="#101827" strokeLinejoin="round" strokeWidth="2">
          <path d="M23 47 20 56h9l3-6 3 6h9l-3-10" fill={`url(#${metal})`} />
          <path d="M19 31c0-5 5-8 13-8s13 3 13 8l3 12c.5 4-2 7-6 7H22c-4 0-6.5-3-6-7l3-12Z" fill={`url(#${metal})`} />
          <path d="M19 34c-4-1-7 2-7 6 0 3 3 5 8 4l3-6M45 34c4-1 7 2 7 6 0 3-3 5-8 4l-3-6" fill={colors.dark} />
          <path d="M20 25c0-8 5-13 12-13s12 5 12 13l-3 7H23l-3-7Z" fill={`url(#${metal})`} />
          <path d="m19 23 5-5 4 3 4-6 4 6 4-3 5 5-3 4H22l-3-4Z" fill={boss === 'prime' ? colors.accent : colors.edge} />
          <path d="M23 27h18l-2.5 6h-13L23 27Z" fill="#152538" stroke={colors.edge} strokeOpacity=".7" />
          <path d="M26 37c2.5-2 9.5-2 12 0v8c-3 3-9 3-12 0v-8Z" fill={boss === 'prime' ? colors.accent : '#e6edf5'} stroke={colors.dark} />
          <path d="M28 39h8M28 43h8" stroke={colors.dark} strokeLinecap="round" />
          {boss === 'prime' && <path d="m30 20 2-5 2 5" fill={colors.accent} stroke={colors.dark} />}
        </g>
      ) : boss === 'dino' ? (
        <g stroke="#10233a" strokeLinejoin="round" strokeWidth="2">
          <path d="M12 29 8 18l12 6c4-7 13-10 21-6l12 8-8 2 4 8-12-3-9 12-5-10-9 3 3-9-5 0Z" fill={colors.dark} />
          <path d="M19 32c1-8 8-14 17-13l12 5-7 5 5 8-13-2-7 10-4-8-9 2 3-7Z" fill={`url(#${metal})`} />
          <path d="m21 24-6-9 11 5M38 19l6-8 1 12" fill={colors.main} />
          <path d="m45 29 11 3-8 4M21 33l-8 3 6 3" fill={colors.edge} />
          <path d="M39 26a2 2 0 1 0 0 .1Z" fill={colors.accent} stroke={colors.accent} />
          <path d="m49 31 3 1-2 1" fill="#10233a" strokeWidth="1" />
          <path d="M26 44 23 52l7-4M36 43l6 7 2-8" fill={colors.dark} />
        </g>
      ) : boss === 'gele' ? (
        <g stroke="#17142b" strokeLinejoin="round" strokeWidth="2">
          <path d="m14 28 4-12 13-7 14 7 5 13-8-4-4 6H22l-4-6-4 3Z" fill={colors.dark} />
          <path d="M21 24c1-8 5-12 11-12s10 4 11 12l-4 8H25l-4-8Z" fill={`url(#${metal})`} />
          <path d="M25 28h14l-2 7-5 4-5-4-2-7Z" fill="#e7c8a5" />
          <path d="m25 35 7 4 7-4-2 13H27l-2-13Z" fill="#efe0ff" />
          <path d="m25 42 7 3 7-3-4 11h-7l-3-11Z" fill={colors.edge} />
          <path d="M15 22v31M11 25h8M11 53h8" stroke={colors.accent} strokeLinecap="round" />
          <circle cx="15" cy="17" r="5" fill={colors.accent} stroke="#47356f" />
          <path d="m32 18 1.5 3.5L37 23l-3.5 1.5L32 28l-1.5-3.5L27 23l3.5-1.5L32 18Z" fill="#fff1b8" stroke="none" />
        </g>
      ) : boss === 'bt' ? (
        <g stroke="#12251d" strokeLinejoin="round" strokeWidth="2">
          <path d="M31 45c-1 5-4 8-9 12m13-12c3 5 6 8 10 11" fill="none" stroke="#356849" strokeLinecap="round" strokeWidth="3" />
          <path d="M29 47c-10 1-16-2-20-8 9 0 16 1 23 5m4 3c10 0 16-3 20-9-9 0-16 2-22 6" fill="#579457" stroke="#b7eb62" strokeWidth="1.4" />
          <path d="M31 47c-10-1-15-7-13-15l-7-3 10-2c0-10 7-16 15-14 9 2 13 10 10 18l8 3-10 3c-1 8-6 11-13 10Z" fill={`url(#${metal})`} />
          <path d="m24 22-5-7 11 4m7-5 4-7 2 11" fill="#579457" />
          <path d="M20 29c4-6 19-8 25-1l-3 8c-6 6-15 6-21 0l-1-7Z" fill="#321f2d" stroke="#ffd1a4" />
          <path d="M22 30c5-4 16-5 22-1m-21 9c5 4 15 4 20 0" fill="none" stroke="#e35658" strokeWidth="2.5" />
          <path d="m24 30 2 4 2-4 2 4 2-4 2 4 2-4 2 4 2-4 2 3" fill="#f3e6c8" stroke="#4b303b" strokeWidth="1" />
          <path d="m29 39 2-3 2 3 2-3 2 3" fill="#f3e6c8" stroke="#4b303b" strokeWidth="1" />
          <path d="m16 22-4-3m7-3-1-5m28 13 5-3m-7-7 2-5m-28 29-6 3m32-1 6 3" fill="none" stroke="#b7eb62" strokeLinecap="round" />
          <ellipse cx="51" cy="16" rx="3.5" ry="2.2" transform="rotate(-25 51 16)" fill="#f5d56e" stroke="#352e28" />
          <path d="m49 15-4-4m5 5-1-6m2 6 4-4m-5 6 2 4" fill="none" stroke="#ffe7a1" strokeLinecap="round" strokeWidth="1.3" />
        </g>
      ) : boss === 'crom' ? (
        <g stroke="#19212c" strokeLinejoin="round" strokeWidth="2">
          <path d="m28 17 4-6 5 5-1 9-7 1-1-9Z" fill={`url(#${metal})`} />
          <path d="m28 26 9-1 3 13-4 4-2-8-1 19-5 1-1-18-4 9-4-3 6-16Z" fill={colors.dark} />
          <path d="m25 33-10 9 3 3 11-7m10-5 9 9-3 4-10-8M29 52l-4 7m9-7 4 7" fill="none" stroke={colors.edge} strokeLinecap="round" />
          <path d="M17 23c6-7 8 6 15 2s5-11 10-9 3 12 9 15M16 34c7-6 9 6 16 2s6-10 11-8 3 10 8 13" fill="none" stroke={colors.accent} strokeLinecap="round" strokeWidth="2.8" />
          <path d="m19 22-2 4m7-2-2 4m12-3-2 4m12 3-2 4m-25 3-2 4m13-2-2 4m13-4-2 4m11-2-2 4" fill="none" stroke="#f5f0ff" strokeLinecap="round" strokeWidth="1.1" />
          <path d="m27 19-4-3 4-3m15 13 5 2-4 4" fill="none" stroke={colors.main} strokeLinecap="round" />
          <path d="M29 18h6m-6 4h6m-6 4h7" stroke="#172030" strokeLinecap="round" strokeWidth="1" />
        </g>
      ) : (
        <g stroke="#263347" strokeLinejoin="round" strokeWidth="2">
          <path d="M22 47 20 55h9l3-6 3 6h9l-3-9" fill={`url(#${metal})`} />
          <path d="M18 31c0-5 6-8 14-8s14 3 14 8l3 12c.5 4-2 7-6 7H21c-4 0-6.5-3-6-7l3-12Z" fill={`url(#${metal})`} />
          <path d="M20 25c0-8 5-13 12-13s12 5 12 13l-3 7H23l-3-7Z" fill={colors.main} />
          <path d="m20 23 5-5 4 3 3-6 5 6 4-3 4 5-3 4H23l-3-4Z" fill={colors.accent} />
          <path d="M23 27h18l-3 6H26l-3-6Z" fill="#152538" />
          <path d="M26 37c3-2 9-2 12 0v8c-3 3-9 3-12 0v-8Z" fill="#b6c5d5" />
        </g>
      )}
      <circle cx="50" cy="48" r="2" fill={colors.glow} fillOpacity=".8" />
    </svg>
  );
}
