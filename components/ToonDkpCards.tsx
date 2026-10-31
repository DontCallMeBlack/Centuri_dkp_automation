import { Coins } from 'lucide-react';
import RoleBadge from './RoleBadge';

interface ToonBalance { rowIndex: number; owner: string; account: string; subClass: string; available: number | null; weeklyEarned: number | null }

export default function ToonDkpCards({ toons, loading }: { toons: ToonBalance[]; loading: boolean }) {
  return <section className="surface p-5 sm:p-6" aria-labelledby="my-toons-title">
    <div className="mb-5 flex items-start justify-between gap-3"><div><p className="page-kicker">Your characters</p><h2 id="my-toons-title" className="mt-1 text-lg font-semibold text-white">My toon DKP</h2><p className="mt-2 text-xs leading-5 text-slate-500">Each toon’s available balance, before auction reservations.</p></div><span className="stat-icon"><Coins size={19} /></span></div>
    {loading ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1].map((key) => <div key={key} className="skeleton h-40" />)}</div>
      : toons.length === 0 ? <p className="rounded-xl border border-dashed border-slate-700/60 p-5 text-sm leading-6 text-slate-400">Your linked toons will appear here once clan leadership connects your account.</p>
      : <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">{toons.map((toon) => <article key={toon.rowIndex} aria-label={`${toon.account || toon.owner} DKP`} className="toon-balance relative overflow-hidden rounded-2xl border border-indigo-300/10 bg-gradient-to-br from-indigo-400/[.07] via-slate-900/40 to-slate-950/40 p-5">
        <div className="flex min-w-0 items-start justify-between gap-3"><h3 className="min-w-0 truncate text-sm font-semibold text-slate-100" title={toon.account || toon.owner}>{toon.account || toon.owner}</h3><RoleBadge role={toon.subClass} gameClass compact /></div>
        <p className="mt-1 truncate text-[10px] text-slate-500">{toon.subClass || 'Unassigned class'}</p>
        <div className="mt-5 flex items-baseline gap-2"><p className={`text-3xl font-semibold tracking-tight tabular-nums ${toon.available === null ? 'text-amber-200' : toon.available < 0 ? 'text-rose-300' : 'text-indigo-100'}`}>{toon.available?.toLocaleString() ?? '—'}</p><span className="text-[10px] font-medium uppercase tracking-widest text-slate-500">DKP</span></div>
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/5 pt-3 text-[10px]"><span className="text-slate-500">Earned this week</span><span className={`font-medium tabular-nums ${toon.weeklyEarned === null ? 'text-amber-200' : toon.weeklyEarned < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{toon.weeklyEarned !== null && toon.weeklyEarned > 0 ? '+' : ''}{toon.weeklyEarned?.toLocaleString() ?? '—'}</span></div>
      </article>)}</div>}
  </section>;
}
