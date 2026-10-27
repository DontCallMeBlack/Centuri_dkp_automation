'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, LoaderCircle, Plus, Search, Shield, Trash2, Users, X } from 'lucide-react';
import Dialog from '@/components/Dialog';
import RoleBadge from '@/components/RoleBadge';
import { ITEM_SUBROLES } from '@/lib/auctionRules';
import { clientDataVersion, getData, invalidateData, peekData, readResponse } from '@/lib/client/api';
import { getActionRequestId, completeActionRequest } from '@/lib/client/actionRequests';

interface Toon {
  rowIndex: number; owner: string; account: string; subClass: string;
  available: number | null; weeklyEarned: number | null; earned: number | null;
  linkedAccounts: string[];
}
interface ToonData { toons: Toon[]; pending: { action: string; owner: string; account: string } | null }

export default function ClanToonsPanel({ active, accountId, onChanged }: { active: boolean; accountId: string; onChanged: () => Promise<unknown> }) {
  const initialToonData = peekData<ToonData>('/api/admin/toons');
  const [data, setData] = useState<ToonData | null>(() => initialToonData);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Toon | null>(null);
  const [wiping, setWiping] = useState<Toon | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [owner, setOwner] = useState('');
  const [account, setAccount] = useState('');
  const [subClass, setSubClass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  const initialLoadStarted = useRef(Boolean(initialToonData));
  useEffect(() => {
    mounted.current = true;
    const clear = () => { initialLoadStarted.current = false; setData(null); setCreating(false); setRemoving(null); setWiping(null); setOwner(''); setAccount(''); setSubClass(''); setError(''); setNotice(''); setConfirmed(false); };
    window.addEventListener('centuri:clear-data', clear);
    return () => { mounted.current = false; window.removeEventListener('centuri:clear-data', clear); };
  }, []);
  const load = useCallback(async () => {
    const version = clientDataVersion();
    const result = await getData<ToonData>('/api/admin/toons');
    if (mounted.current && version === clientDataVersion()) { setData(result); setReadError(''); }
  }, []);
  useEffect(() => {
    if (!active || initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void load().catch((cause) => setReadError(cause instanceof Error ? cause.message : 'Clan toons could not be loaded.'));
  }, [active, load]);
  useEffect(() => {
    if (!active) return;
    const reloadForSessionChange = () => {
      initialLoadStarted.current = true;
      void load().catch((cause) => setReadError(cause instanceof Error ? cause.message : 'Clan toons could not be loaded.'));
    };
    window.addEventListener('centuri:session-updated', reloadForSessionChange);
    return () => window.removeEventListener('centuri:session-updated', reloadForSessionChange);
  }, [active, load]);

  const submit = async (action: 'create' | 'remove' | 'wipe' | 'recover', payload: Record<string, unknown> = {}) => {
    if (pending.current || !accountId) return;
    pending.current = true; setBusy(true); setError(''); setNotice(action === 'recover' ? 'Finishing the interrupted roster change…' : action === 'create' ? 'Adding toon and syncing the roster…' : action === 'wipe' ? 'Resetting Available DKP and updating open bids…' : 'Removing toon and syncing DKP and links…');
    const version = clientDataVersion();
    try {
      const requestId = action === 'recover' ? undefined : await getActionRequestId(accountId, `clan-toon:${action}`, payload);
      const response = await fetch('/api/admin/toons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...payload, requestId }) });
      const result = await readResponse<{ message: string; rowIndex?: number; replayed?: boolean }>(response);
      if (action !== 'recover') await completeActionRequest(accountId, `clan-toon:${action}`, payload);
      if (!mounted.current || version !== clientDataVersion()) return;
      setNotice(result.message); setCreating(false); setRemoving(null); setWiping(null); setConfirmed(false);
      if (action === 'create') { setOwner(''); setAccount(''); setSubClass(''); }
      if (data && action === 'create' && !result.replayed && typeof result.rowIndex === 'number') {
        const added: Toon = { rowIndex: result.rowIndex, owner: String(payload.owner ?? ''), account: String(payload.account ?? ''), subClass: String(payload.subClass ?? ''), available: 0, weeklyEarned: 0, earned: 0, linkedAccounts: [] };
        const toons = [...data.toons.filter((toon) => toon.rowIndex !== added.rowIndex && toon.account.toLowerCase() !== added.account.toLowerCase()), added].sort((first, second) => first.rowIndex - second.rowIndex);
        setData({ ...data, toons, pending: null });
      } else if (data && action === 'remove' && !result.replayed && typeof payload.rowIndex === 'number') {
        const removedRow = payload.rowIndex;
        const remaining = data.toons.filter((toon) => toon.rowIndex !== removedRow).sort((first, second) => first.rowIndex - second.rowIndex);
        setData({ ...data, toons: remaining.map((toon, index) => ({ ...toon, rowIndex: index + 3 })), pending: null });
      } else if (data && action === 'wipe' && !result.replayed && typeof payload.rowIndex === 'number') {
        setData({ ...data, toons: data.toons.map((toon) => toon.rowIndex === payload.rowIndex ? { ...toon, available: 0 } : toon) });
      }
      for (const url of ['/api/admin/toons', '/api/admin/requests', '/api/dkp', '/api/auction', '/api/auth/session', '/api/admin/boss-history']) invalidateData(url);
      window.dispatchEvent(new Event('centuri:dkp-changed'));
      void Promise.all([load(), onChanged()]).catch(() => setReadError('The change was saved. Updated lists will appear when the connection recovers.'));
    } catch (cause) {
      if (mounted.current && version === clientDataVersion()) {
        setNotice('');
        setError(cause instanceof Error ? cause.message : 'The change could not be confirmed. Retry the same action.');
        invalidateData('/api/admin/toons');
        await load().catch(() => undefined);
      }
    } finally { pending.current = false; if (mounted.current && version === clientDataVersion()) setBusy(false); }
  };
  const visible = (data?.toons ?? []).filter((toon) => `${toon.account} ${toon.owner} ${toon.subClass} ${toon.linkedAccounts.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));
  const blocked = busy || Boolean(data?.pending);
  const amount = (value: number | null) => value === null ? 'Needs review' : value.toLocaleString();

  return <div className="mt-6 space-y-5">
    <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p className="page-kicker">The clan roster</p><h2 className="mt-1 text-xl font-bold text-white">Every toon starts here.</h2><p className="mt-2 text-sm leading-6 text-slate-400">Add a new clan toon with zero DKP, then link it to an account from Members.</p></div><button type="button" className="primary-button self-start" disabled={blocked || !data} onClick={() => { setError(''); setCreating(true); }}><Plus size={16} />Add a toon</button></header>
    {(error || readError) && <p role="alert" className="rounded-xl border border-rose-400/20 bg-rose-500/10 p-3 text-sm text-rose-200">{error || readError}</p>}
    {notice && <p role="status" aria-live="polite" className={`flex items-center gap-2 rounded-xl border p-3 text-sm ${busy ? 'border-indigo-400/20 bg-indigo-500/10 text-indigo-200' : 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200'}`}>{busy && <LoaderCircle size={15} className="animate-spin" />}{notice}</p>}
    {data?.pending && <div className="rounded-2xl border border-amber-300/20 bg-amber-400/5 p-4"><p className="text-sm font-semibold text-amber-200">An interrupted toon change needs to finish</p><p className="mt-2 text-xs text-slate-400">{data.pending.action === 'create' ? 'Adding' : 'Removing'} {data.pending.account || data.pending.owner}. Finish the original operation before making another change.</p><button type="button" className="secondary-button mt-3" disabled={busy} onClick={() => void submit('recover')}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Shield size={15} />}Finish interrupted change</button></div>}
    <label className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2.5"><Search size={16} className="text-slate-500" /><input aria-label="Search clan toons" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search toon, owner, subrole or linked account…" className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none" /><span className="text-xs tabular-nums text-slate-500">{visible.length}</span></label>
    {!data && !readError ? <div role="status" aria-label="Preparing clan toons" aria-busy="true" className="grid gap-3 lg:grid-cols-2"><span className="sr-only">Loading clan toons</span>{[0, 1, 2, 3].map((key) => <article key={key} className="rounded-2xl border border-white/5 bg-slate-950/30 p-4"><div className="flex items-center justify-between gap-3"><div className="skeleton h-4 w-36" /><div className="skeleton h-6 w-24 rounded-full" /></div><div className="skeleton mt-2 h-3 w-28" /><div className="mt-5 flex justify-between"><div><div className="skeleton h-3 w-24" /><div className="skeleton mt-2 h-6 w-16" /><div className="skeleton mt-3 h-3 w-32" /></div><div className="skeleton h-9 w-28 rounded-lg" /></div></article>)}</div> : <div className="grid gap-3 lg:grid-cols-2">{visible.map((toon) => <article key={toon.rowIndex} className="rounded-2xl border border-white/5 bg-gradient-to-br from-slate-900/70 to-slate-950/30 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words font-semibold text-white">{toon.account || 'Unnamed toon'}</h3><p className="mt-1 break-words text-xs text-slate-500">Owner: {toon.owner}</p></div><RoleBadge role={toon.subClass} gameClass /></div><div className="mt-4 flex flex-wrap items-end justify-between gap-3"><div><p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Available DKP</p><p className="mt-1 text-xl font-bold tabular-nums text-indigo-200">{amount(toon.available)}</p><p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500"><Users size={12} />{toon.linkedAccounts.length ? toon.linkedAccounts.join(', ') : 'Unlinked'}</p></div><div className="flex flex-wrap justify-end gap-2"><button type="button" className="secondary-button !border-amber-400/20 !text-amber-200 hover:!bg-amber-500/10" disabled={blocked} onClick={() => { setError(''); setConfirmed(false); setWiping(toon); }}><Eraser size={14} />Wipe DKP</button><button type="button" className="secondary-button !border-rose-400/20 !text-rose-300 hover:!bg-rose-500/10" disabled={blocked} onClick={() => { setError(''); setConfirmed(false); setRemoving(toon); }}><Trash2 size={14} />Remove toon</button></div></div></article>)}</div>}
    {data && !visible.length && <p className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">{data.toons.length ? 'No toons match your search.' : 'No clan toons yet. Add the first toon above.'}</p>}

    {creating && <Dialog labelledBy="create-clan-toon-title" busy={busy} onClose={() => setCreating(false)} className="!max-w-xl"><form onSubmit={(event) => { event.preventDefault(); void submit('create', { owner: owner.trim(), account: account.trim(), subClass }); }} className="bg-gradient-to-br from-indigo-500/10 via-transparent to-violet-500/5 p-5 sm:p-7"><header className="flex items-start justify-between gap-3"><div><p className="page-kicker">A new clan toon</p><h2 id="create-clan-toon-title" className="mt-1 text-xl font-bold text-white">Ready for their first raid.</h2></div><button type="button" aria-label="Close new toon form" className="icon-button" disabled={busy} onClick={() => setCreating(false)}><X size={19} /></button></header><fieldset disabled={busy} className="mt-5 space-y-4"><label className="block space-y-2 text-xs font-semibold text-slate-300"><span>Toon name</span><input required maxLength={80} value={account} onChange={(event) => setAccount(event.target.value)} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-white outline-none focus:border-indigo-400" /></label><label className="block space-y-2 text-xs font-semibold text-slate-300"><span>Owner</span><input required maxLength={80} value={owner} onChange={(event) => setOwner(event.target.value)} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-white outline-none focus:border-indigo-400" /></label><fieldset className="space-y-2"><legend className="mb-2 text-xs font-semibold text-slate-300">Toon subrole</legend><div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">{ITEM_SUBROLES.filter((role) => role !== 'Everyone').map((role) => <label key={role} className={`flex cursor-pointer items-center gap-2 rounded-xl border p-3 ${subClass === role ? 'border-indigo-400/60 bg-indigo-500/15' : 'border-white/5 bg-white/[0.02] hover:border-white/20'}`}><input required type="radio" name="new-toon-subrole" value={role} checked={subClass === role} onChange={() => setSubClass(role)} className="accent-indigo-400" /><RoleBadge role={role} gameClass /></label>)}</div></fieldset></fieldset><p className="mt-4 rounded-xl border border-indigo-400/15 bg-indigo-400/5 p-3 text-xs leading-5 text-indigo-200">All DKP and activity values start at 0. This toon stays unlinked until you assign it to an account.</p>{error && <p role="alert" className="mt-4 text-sm text-rose-200">{error}</p>}<footer className="mt-6 flex justify-end gap-2 border-t border-white/5 pt-5"><button type="button" className="secondary-button" disabled={busy} onClick={() => setCreating(false)}>Cancel</button><button type="submit" className="primary-button" disabled={blocked || !subClass || !owner.trim() || !account.trim()}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Plus size={15} />}Add clan toon</button></footer></form></Dialog>}

    {wiping && <Dialog labelledBy="wipe-clan-toon-title" busy={busy} onClose={() => setWiping(null)} className="!max-w-lg"><div className="bg-gradient-to-br from-amber-500/10 via-transparent to-slate-950 p-5 sm:p-7"><header className="flex items-start justify-between gap-3"><div><p className="page-kicker !text-amber-200">Reset available points</p><h2 id="wipe-clan-toon-title" className="mt-1 break-all text-xl font-bold text-white">Wipe {wiping.account || wiping.owner}?</h2></div><button type="button" className="icon-button" aria-label="Cancel DKP wipe" disabled={busy} onClick={() => setWiping(null)}><X size={19} /></button></header><div className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4"><p className="text-xs text-slate-400">Owner: {wiping.owner}</p><p className="mt-2 text-xl font-bold text-amber-100">{amount(wiping.available)} <span className="text-xs font-normal">available DKP will become 0</span></p></div><p className="mt-4 text-sm leading-6 text-slate-300">Earned and spent DKP stay unchanged. Bids on active auctions are withdrawn and the next eligible bid moves up. Completed auctions and pending mail stay unchanged.</p><label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 p-3 text-xs leading-5 text-slate-300"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 accent-amber-400" /><span>I confirm resetting this toon’s Available DKP to 0.</span></label>{error && <p role="alert" className="mt-4 text-sm text-rose-200">{error}</p>}<footer className="mt-6 flex justify-end gap-2 border-t border-white/5 pt-5"><button type="button" className="secondary-button" disabled={busy} onClick={() => setWiping(null)}>Cancel</button><button type="button" disabled={blocked || !confirmed} className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-40" onClick={() => void submit('wipe', { rowIndex: wiping.rowIndex, owner: wiping.owner, account: wiping.account, wipeConfirmed: true })}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Eraser size={15} />}Wipe Available DKP</button></footer></div></Dialog>}

    {removing && <Dialog labelledBy="remove-clan-toon-title" busy={busy} onClose={() => setRemoving(null)} className="!max-w-lg"><div className="bg-gradient-to-br from-rose-500/10 via-transparent to-slate-950 p-5 sm:p-7"><header className="flex items-start justify-between gap-3"><div><p className="page-kicker !text-rose-300">Clan roster</p><h2 id="remove-clan-toon-title" className="mt-1 break-all text-xl font-bold text-white">Remove {removing.account || removing.owner}?</h2></div><button type="button" className="icon-button" aria-label="Cancel toon removal" disabled={busy} onClick={() => setRemoving(null)}><X size={19} /></button></header><p className="mt-4 text-sm leading-6 text-slate-400">This removes the roster entry, forfeits its DKP and unlinks its accounts. You can restore it from the Activity log; its auction bids stay withdrawn.</p><div className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-400/5 p-4"><p className="text-xs text-slate-400">Owner: {removing.owner}</p><p className="mt-2 text-xl font-bold text-rose-200">{amount(removing.available)} <span className="text-xs font-normal">available DKP forfeited</span></p><p className="mt-2 text-xs text-slate-400">Linked accounts: {removing.linkedAccounts.join(', ') || 'None'}</p></div><p className="mt-3 text-xs leading-5 text-slate-500">Active reservations, pending delivery and unfinished awards must be resolved first.</p><label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 p-3 text-xs leading-5 text-slate-300"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 accent-rose-400" /><span>I confirm removal and DKP forfeiture.</span></label>{error && <p role="alert" className="mt-4 text-sm text-rose-200">{error}</p>}<footer className="mt-6 flex justify-end gap-2 border-t border-white/5 pt-5"><button type="button" className="secondary-button" disabled={busy} onClick={() => setRemoving(null)}>Keep toon</button><button type="button" disabled={blocked || !confirmed} className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-40" onClick={() => void submit('remove', { rowIndex: removing.rowIndex, owner: removing.owner, account: removing.account, forfeitConfirmed: true })}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Trash2 size={15} />}Remove &amp; forfeit DKP</button></footer></div></Dialog>}
  </div>;
}
