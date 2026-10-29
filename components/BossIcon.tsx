import { useId } from 'react';

export default function BossIcon({ bossName, className = 'h-10 w-10' }: { bossName: string; className?: string }) {
  const id = useId().replace(/:/g, '');
  const boss = bossName.trim().toLowerCase();
  const colors = boss === 'base'
    ? { glow: '#a9c0d9', edge: '#dbe8f5', main: '#b8c7d8', dark: '#647b96', accent: '#eaf3fb' }
    : boss === 'prime'
      ? { glow: '#f4c95d', edge: '#ffebad', main: '#dba936', dark: '#8c5d1d', accent: '#fff0a8' }
      : boss === 'bt'
        ? { glow: '#75e38d', edge: '#c1ff82', main: '#61c967', dark: '#27694e', accent: '#f5e978' }
        : boss === 'gele'
          ? { glow: '#b39aff', edge: '#e7d8ff', main: '#9574e8', dark: '#523d9c', accent: '#ffd17d' }
          : boss === 'dino'
            ? { glow: '#62d8ff', edge: '#c4f4ff', main: '#38a9e5', dark: '#20568e', accent: '#a7f1ff' }
            : { glow: '#eea66b', edge: '#ffe0bb', main: '#986c60', dark: '#503d4a', accent: '#ffd092' };
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
          <path d="M31 49c-11-1-15-7-13-16 1-5 5-9 11-11-1-5 1-10 5-14 5 6 7 11 6 16 6 2 10 7 9 13-1 9-8 13-18 12Z" fill={`url(#${metal})`} />
          <path d="M30 27c-7 0-11 4-11 9 0 4 4 7 12 7l2-7-3-9Z" fill="#d2ff9d" />
          <path d="M34 27c8 0 12 4 12 9 0 4-4 7-12 7l-2-7 2-9Z" fill="#91e979" />
          <path d="m21 32 4 3-3 1 4 3M43 32l-4 3 3 1-4 3" fill="none" stroke="#2d6b47" strokeLinecap="round" />
          <path d="M31 43 26 51h12l-5-8" fill={colors.dark} />
          <path d="m37 19 7-7-1 11" fill={colors.edge} />
          <ellipse cx="48" cy="20" rx="4" ry="2.5" transform="rotate(-30 48 20)" fill={colors.accent} />
          <path d="m45 18-4-4m5 5-1-6m2 6 4-4m-5 6 1 5" stroke="#ffe994" strokeLinecap="round" strokeWidth="1.5" />
        </g>
      ) : boss === 'crom' ? (
        <g stroke="#19212c" strokeLinejoin="round" strokeWidth="2">
          <path d="m27 19 5-6 6 5-2 8h-8l-1-7Z" fill={`url(#${metal})`} />
          <path d="m28 27 9-1 4 14-5 3-1-9-3 19-5-1 2-17-5 8-4-3 8-13Z" fill={colors.dark} />
          <path d="m24 34-9 7 3 3 10-6M38 34l9 6-2 4-10-6M29 51l-4 8M37 52l6 7" fill="none" stroke={colors.edge} strokeLinecap="round" />
          <path d="M15 27c6-5 8 7 14 2s6-10 11-7 2 12 9 12" fill="none" stroke={colors.accent} strokeLinecap="round" strokeWidth="3" />
          <path d="m18 25-2 4m7-1-2 4m14-8-2 4m13 3-2 4" stroke="#fff0cb" strokeLinecap="round" strokeWidth="1.2" />
          <path d="m26 20-4-2 4-3m15 13 5 2-4 3" fill="none" stroke={colors.main} strokeLinecap="round" />
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
