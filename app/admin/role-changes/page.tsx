'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, ArrowRight, CalendarClock, Check, CircleAlert, Clock3, LoaderCircle, RotateCcw, Search, ShieldCheck, UserCheck, UsersRound, X } from 'lucide-react';
import LoadingSurface from '@/components/LoadingSurface';
import RoleBadge from '@/components/RoleBadge';
import { useSessionUser } from '@/components/AppShell';
import { ApiError, clearClientData, getData, invalidateData, notifyDkpChanged, readResponse } from '@/lib/client/api';
import { getAlternateToonSubrole } from '@/lib/auctionRules';
import { ROLE_CHANGE_TIME_ZONE } from '@/lib/toonRoleChanges';
import { useAutoRefresh } from '@/lib/client/useAutoRefresh';

type RequestStatus = 'pending' | 'approved';
type AuditAction = 'requested' | 'approved' | 'denied' | 'cancelled' | 'expired';
interface ToonRequest {
  id: string;
  status: RequestStatus;
  requestedRole: string;
  requestedByNickname: string;
  decidedByNickname: string | null;
  createdAt: string;
  effectiveAt: string;
}

interface ManagedToon {
  rowIndex: number;
  owner: string;
  account: string;
  currentRole: string;
  scheduledRole: string | null;
  effectiveAt: string | null;
  request: ToonRequest | null;
  canRequest: boolean;
  canCancel: boolean;
  duplicateIdentity: boolean;
}

interface RoleAuditEntry {
  id: string;
  action: AuditAction;
  owner: string;
  account: string;
  previousRole: string;
  scheduledRole: string;
  effectiveAt: string | null;
  actorUserId: string | null;
  actorNickname: string;
  actorRole: string;
  createdAt: string;
}

interface RoleChangeData {
  isGeneral: boolean;
  toons: ManagedToon[];
  nextChangeAt: string;
  audit: RoleAuditEntry[];
}

type MutationAction = 'request' | 'approve' | 'deny' | 'cancel';
function dateLabel(value: string | null | undefined, options: Intl.DateTimeFormatOptions = { dateStyle: 'long' }) {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: ROLE_CHANGE_TIME_ZONE }).format(new Date(value));
}

export default function RoleChangesPage() {
  const user = useSessionUser();
  const router = useRouter();
  const mounted = useRef(true);
  const [data, setData] = useState<RoleChangeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    if (!mounted.current) return false;
    try {
      const result = await getData<RoleChangeData>('/api/role-changes');
      if (!mounted.current) return;
      setData(result);
      setError('');
      return true;
    } catch (cause) {
      if (!mounted.current) return false;
      if (cause instanceof ApiError && cause.status === 401) { clearClientData(); router.replace('/login'); }
      else setError(cause instanceof Error ? cause.message : 'Role requests could not be refreshed.');
      return false;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    mounted.current = true;
    const clear = () => { setData(null); setQuery(''); setLoading(true); setBusyKey(''); setError(''); setNotice(''); };
    window.addEventListener('centuri:clear-data', clear);
    return () => { mounted.current = false; window.removeEventListener('centuri:clear-data', clear); };
  }, []);

  useAutoRefresh(load, { active: Boolean(user), onError: (cause) => setError(cause instanceof Error ? cause.message : 'Role requests could not be refreshed.') });

  const mutate = async (action: MutationAction, toon: ManagedToon, requestId?: string) => {
    const key = requestId ?? `${action}:${toon.rowIndex}`;
    if (busyKey) return;
    setBusyKey(key);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/role-changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action,
          ...(action === 'request' ? { rowIndex: toon.rowIndex } : { requestId }),
        }),
      });
      const result = await readResponse<{ message: string }>(response);
      setNotice(result.message);
      invalidateData('/api/role-changes');
      notifyDkpChanged();
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { clearClientData(); router.replace('/login'); }
      else setError(cause instanceof Error ? cause.message : 'The role request could not be completed.');
    } finally {
      setBusyKey('');
    }
  };

  const filteredToons = (data?.toons ?? []).filter((toon) =>
    `${toon.owner} ${toon.account} ${toon.currentRole} ${toon.request?.requestedRole ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const pendingRequests = data?.toons.filter((toon) => toon.request?.status === 'pending') ?? [];

  return <div className="space-y-6">
    <header className="relative overflow-hidden rounded-3xl border border-indigo-300/15 bg-gradient-to-br from-indigo-950 via-slate-900 to-violet-950 p-6 shadow-xl shadow-indigo-950/20 sm:p-8">
      <div className="pointer-events-none absolute -right-12 -top-20 h-64 w-64 rounded-full bg-indigo-400/10 blur-3xl" />
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <p className="page-kicker flex items-center gap-2"><CalendarClock size={14} /> Monthly role changes</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">{data?.isGeneral ? 'Review subrole changes.' : 'Switch a toon’s subrole.'}</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-slate-300">{data?.isGeneral ? 'Approve or deny member requests. Approved switches appear here until they take effect.' : 'Request the other subrole for one of your toons. A General must approve it before the monthly cutoff.'}</p>
        </div>
        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/35 px-4 py-3 backdrop-blur">
          <span className="rounded-xl border border-indigo-300/15 bg-indigo-300/10 p-2.5 text-indigo-200"><Clock3 size={18} /></span>
          <div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-slate-400">Next monthly cutoff</p><p className="mt-1 text-sm font-semibold text-white">{data ? dateLabel(data.nextChangeAt) : 'Loading date…'}</p><p className="mt-1 text-[10px] text-slate-400">12:00 AM · EST (UTC−05:00)</p></div>
        </div>
      </div>
      <div className="relative mt-7 grid gap-2 rounded-2xl border border-white/[.08] bg-slate-950/30 p-4 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
        <div><span className="text-[9px] font-bold uppercase tracking-[.16em] text-indigo-200/70">Until the 1st</span><p className="mt-1 text-xs text-slate-200">The current subrole stays active while a request is pending.</p></div>
        <ArrowRight className="hidden text-indigo-300/70 sm:block" size={17} />
        <div className="sm:text-right"><span className="text-[9px] font-bold uppercase tracking-[.16em] text-emerald-200/70">After approval and cutoff</span><p className="mt-1 text-xs text-slate-200">The new subrole becomes active for bids.</p></div>
      </div>
    </header>

    {error && <p role="alert" className="flex items-start gap-2 rounded-xl border border-rose-400/20 bg-rose-400/5 px-4 py-3 text-sm text-rose-200"><CircleAlert size={16} className="mt-0.5 shrink-0" />{error}</p>}
    {notice && <p role="status" className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-4 py-3 text-sm text-emerald-200"><Check size={16} />{notice}</p>}

    {data?.isGeneral && <section className="surface overflow-hidden" aria-labelledby="review-queue-title">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[.06] p-5 sm:p-6"><div className="flex items-center gap-3"><span className="rounded-xl border border-amber-300/15 bg-amber-300/10 p-2.5 text-amber-200"><UserCheck size={17} /></span><div><p className="page-kicker">General review</p><h2 id="review-queue-title" className="mt-1 text-base font-semibold text-white">Requests waiting for a decision</h2></div></div><span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-xs font-bold tabular-nums text-amber-100">{pendingRequests.length} pending</span></div>
      {loading ? <div className="p-4"><LoadingSurface rows={2} label="Loading role change requests" /></div> : pendingRequests.length === 0 ? <p className="p-6 text-sm text-slate-500">The review queue is clear. New requests expire at the monthly cutoff if left undecided.</p> : <div className="divide-y divide-white/[.05]">{pendingRequests.map((toon) => {
        const request = toon.request!;
        const busy = busyKey === request.id;
        return <article key={request.id} className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="min-w-0"><p className="truncate text-sm font-semibold text-white">{toon.account || toon.owner}<span className="ml-2 text-xs font-normal text-slate-500">· {toon.owner}</span></p><p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-400"><span>{request.requestedByNickname} requested</span><RoleBadge role={toon.currentRole} gameClass compact /><ArrowRight size={12} /><RoleBadge role={request.requestedRole} gameClass compact /><span>· review by {dateLabel(request.effectiveAt)}</span></p></div>
          <div className="flex shrink-0 gap-2"><button type="button" disabled={Boolean(busyKey)} onClick={() => void mutate('deny', toon, request.id)} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-700 px-3 py-2.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-800 disabled:opacity-50">{busy ? <LoaderCircle size={14} className="animate-spin" /> : <X size={14} />}Deny</button><button type="button" disabled={Boolean(busyKey)} onClick={() => void mutate('approve', toon, request.id)} className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-green-600 px-3 py-2.5 text-xs font-bold text-white shadow-lg shadow-emerald-950/20 transition hover:from-emerald-500 hover:to-green-500 disabled:opacity-50">{busy ? <LoaderCircle size={14} className="animate-spin" /> : <Check size={14} />}Approve</button></div>
        </article>;
      })}</div>}
    </section>}

    <section className="space-y-4" aria-labelledby="roster-role-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="page-kicker">{data?.isGeneral ? 'Full clan roster' : 'Your linked toons'}</p><h2 id="roster-role-title" className="mt-1 text-xl font-semibold text-white">Role request status</h2><p className="mt-1 text-xs text-slate-500">{data ? `${data.toons.length} toons · all dates use EST (UTC−05:00)` : 'Loading clan toons…'}</p></div>
        <label className="relative w-full sm:max-w-xs"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search owner, toon, or role" aria-label="Search clan toons" className="w-full rounded-xl border border-slate-800 bg-slate-950 py-2.5 pl-9 pr-3 text-xs text-slate-100 placeholder:text-slate-600 outline-none focus:border-indigo-400/50" /></label>
      </div>

      {loading ? <LoadingSurface rows={5} label="Loading role request status" /> : filteredToons.length === 0 ? (
        <div className="surface rounded-2xl border-dashed p-10 text-center"><UsersRound className="mx-auto h-7 w-7 text-slate-600" /><p className="mt-3 text-sm font-semibold text-slate-300">{data?.toons.length ? 'No toons match this search.' : 'No linked toons found. Ask a General to link your account to the roster.'}</p></div>
      ) : <div className="grid gap-4 xl:grid-cols-2">{filteredToons.map((toon) => {
        const request = toon.request;
        const pending = request?.status === 'pending';
        const scheduled = request?.status === 'approved';
        const alternateRole = getAlternateToonSubrole(toon.currentRole);
        const canSubmitRequest = toon.canRequest && Boolean(alternateRole) && !toon.duplicateIdentity;
        const busy = busyKey === (request?.id ?? `request:${toon.rowIndex}`);
        return <article key={toon.rowIndex} className="surface relative overflow-hidden p-5 sm:p-6">
          {(pending || scheduled) && <div className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent ${scheduled ? 'via-emerald-300/70' : 'via-amber-300/70'} to-transparent`} />}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[.16em] text-slate-500">{toon.owner}</p><h3 className="mt-1 truncate text-lg font-semibold text-white">{toon.account || toon.owner}</h3></div>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold ${scheduled ? 'border-emerald-300/20 bg-emerald-300/10 text-emerald-200' : pending ? 'border-amber-300/20 bg-amber-300/10 text-amber-100' : 'border-slate-700 bg-slate-900 text-slate-400'}`}>
              {scheduled ? 'Scheduled' : pending ? 'Waiting for approval' : 'Current subrole'}
            </span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-white/[.06] bg-slate-950/45 p-3">
            <div><p className="mb-1 text-[9px] font-bold uppercase tracking-widest text-slate-500">Active for bids</p><RoleBadge role={toon.currentRole} gameClass /></div>
            {(pending || scheduled) && request && <><ArrowRight className="mx-1 text-slate-600" size={15} /><div><p className={`mb-1 text-[9px] font-bold uppercase tracking-widest ${scheduled ? 'text-emerald-300/70' : 'text-amber-200/70'}`}>{scheduled ? `After ${dateLabel(request.effectiveAt, { month: 'short', day: 'numeric' })}` : 'Requested subclass'}</p><RoleBadge role={request.requestedRole} gameClass /></div></>}
            {scheduled && request && <span className="ml-auto text-[10px] text-emerald-200/80">Approved by {request.decidedByNickname || 'a General'} · {dateLabel(request.effectiveAt)}</span>}
            {pending && request && <span className="ml-auto text-[10px] text-amber-100/70">Requested by {request.requestedByNickname}</span>}
          </div>

          {toon.duplicateIdentity ? <p className="mt-4 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-xs text-amber-100">This owner and toon name appear more than once. Reconcile the duplicate before requesting a change.</p> : <>
            {toon.canRequest && !request && alternateRole && <div className="mt-4 flex flex-col gap-3 border-t border-white/[.06] pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0"><p className="text-xs font-semibold text-slate-200">Switch to</p><div className="mt-2 flex items-center gap-2"><RoleBadge role={toon.currentRole} compact /><ArrowRight size={13} className="text-slate-500" /><RoleBadge role={alternateRole} compact /></div><p className="mt-2 text-[10px] text-slate-500">A General must approve by {dateLabel(data?.nextChangeAt)}.</p></div>
              <button type="button" disabled={!canSubmitRequest || Boolean(busyKey)} onClick={() => void mutate('request', toon)} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-indigo-950/30 transition hover:from-indigo-400 hover:to-violet-400 disabled:cursor-not-allowed disabled:opacity-40">{busy ? <LoaderCircle size={14} className="animate-spin" /> : <CalendarClock size={14} />}Request {alternateRole}</button>
            </div>}
            {toon.canRequest && !request && !alternateRole && <p className="mt-4 border-t border-white/[.06] pt-4 text-xs text-slate-500">Ranger has one subrole, so there is no switch to request.</p>}
            {pending && request && <div className="mt-4 flex flex-col gap-2 border-t border-white/[.06] pt-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-[10px] leading-5 text-slate-500">Waiting for a General · expires {dateLabel(request.effectiveAt)} if unanswered.</p>{toon.canCancel && <button type="button" disabled={Boolean(busyKey)} onClick={() => void mutate('cancel', toon, request.id)} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-700 px-3 py-2.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-800 disabled:opacity-50">{busy ? <LoaderCircle size={14} className="animate-spin" /> : <RotateCcw size={14} />}Cancel request</button>}</div>}
            {scheduled && request && <div className="mt-4 flex flex-col gap-2 border-t border-white/[.06] pt-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-[10px] leading-5 text-slate-500">Current role stays active until the approved date. New bids then use only {request.requestedRole}.</p>{toon.canCancel && <button type="button" disabled={Boolean(busyKey)} onClick={() => void mutate('cancel', toon, request.id)} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-700 px-3 py-2.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-800 disabled:opacity-50">{busy ? <LoaderCircle size={14} className="animate-spin" /> : <RotateCcw size={14} />}Cancel scheduled change</button>}</div>}
            {!toon.canRequest && !request && data?.isGeneral && <p className="mt-4 border-t border-white/[.06] pt-4 text-[10px] text-slate-500">No active request. Members can request changes for their linked toons.</p>}
          </>}
        </article>;
      })}</div>}
    </section>

    <section className="surface overflow-hidden" aria-labelledby="role-audit-title">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[.06] p-5 sm:p-6"><div className="flex items-center gap-3"><span className="rounded-xl border border-indigo-300/15 bg-indigo-300/10 p-2.5 text-indigo-200"><Activity size={17} /></span><div><p className="page-kicker">Accountability</p><h2 id="role-audit-title" className="mt-1 text-base font-semibold text-white">Role request activity</h2></div></div><span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-950/60 px-2.5 py-1 text-[10px] text-slate-400"><ShieldCheck size={12} /> Decisions are logged</span></div>
      {!data?.audit.length ? <p className="p-6 text-sm text-slate-500">No role request activity yet.</p> : <div className="divide-y divide-white/[.05]">{data.audit.map((entry) => <article key={entry.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-200">{entry.account || entry.owner}<span className="ml-2 font-normal text-slate-500">· {entry.owner}</span></p><p className="mt-1 text-xs text-slate-400">{entry.action === 'requested' ? 'Requested' : entry.action === 'approved' ? 'Approved' : entry.action === 'denied' ? 'Denied' : entry.action === 'expired' ? 'Expired without review' : 'Cancelled'}: {entry.previousRole} <ArrowRight className="mx-1 inline h-3 w-3" /> {entry.scheduledRole}{entry.effectiveAt ? ` · effective ${dateLabel(entry.effectiveAt)}` : ''}</p></div>
        <p className="shrink-0 text-[10px] text-slate-500">{entry.actorRole === 'system' ? 'System' : <>By <span className="font-semibold text-indigo-200">{entry.actorNickname}</span> ({entry.actorRole})</>} · {dateLabel(entry.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}</p>
      </article>)}</div>}
      <p className="border-t border-white/[.06] px-5 py-3 text-[10px] text-slate-600 sm:px-6">Showing up to the latest 100 actions. General decisions are retained in the audit history.</p>
    </section>
  </div>;
}
