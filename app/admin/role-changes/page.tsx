'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeftRight, ArrowRight, CalendarDays, Check, CircleAlert, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import LoadingSurface from '@/components/LoadingSurface';
import RoleBadge from '@/components/RoleBadge';
import { useSessionUser } from '@/components/AppShell';
import { ApiError, clearClientData, getData, invalidateData, notifyDkpChanged, peekData, readResponse } from '@/lib/client/api';
import { getAlternateToonSubrole } from '@/lib/auctionRules';
import { ROLE_CHANGE_TIME_ZONE } from '@/lib/toonRoleChanges';

type RequestStatus = 'pending' | 'approved';
interface ToonRequest {
  id: string;
  status: RequestStatus;
  requestedRole: string;
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
  isOwned: boolean;
  canRequest: boolean;
  canCancel: boolean;
  duplicateIdentity: boolean;
}

interface RoleChangeData {
  canApprove: boolean;
  toons: ManagedToon[];
  nextChangeAt: string;
}

type MutationAction = 'request' | 'approve' | 'deny' | 'cancel';
function dateLabel(value: string | null | undefined, options: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', year: 'numeric' }) {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: ROLE_CHANGE_TIME_ZONE }).format(new Date(value));
}

export default function RoleChangesPage() {
  const user = useSessionUser();
  const router = useRouter();
  const mounted = useRef(true);
  const initialData = peekData<RoleChangeData>('/api/role-changes');
  const initialLoadStarted = useRef(Boolean(initialData));
  const [data, setData] = useState<RoleChangeData | null>(() => initialData);
  const [loading, setLoading] = useState(() => !initialData);
  const [busyKey, setBusyKey] = useState('');
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
    const clear = () => { initialLoadStarted.current = false; setData(null); setLoading(true); setBusyKey(''); setError(''); setNotice(''); };
    window.addEventListener('centuri:clear-data', clear);
    return () => { mounted.current = false; window.removeEventListener('centuri:clear-data', clear); };
  }, []);

  useEffect(() => {
    if (!user || initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void load();
  }, [user?.id, user?.role, user?.sheetRecordRows?.join(','), load]);

  const mutate = async (action: MutationAction, toon: ManagedToon, requestId?: string) => {
    const key = `${action}:${requestId ?? toon.rowIndex}`;
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

  const pendingRequests = data?.toons.filter((toon) => toon.request?.status === 'pending') ?? [];
  const visibleToons = data?.toons ?? [];
  const orderedToons = [...visibleToons]
    .filter((toon) => !data?.canApprove || toon.isOwned || toon.request !== null)
    .sort((first, second) => Number(second.isOwned) - Number(first.isOwned) ||
      Number(second.request?.status === 'pending') - Number(first.request?.status === 'pending') ||
      first.rowIndex - second.rowIndex);

  return <div className="mx-auto max-w-5xl space-y-6">
    <header className="role-changes-heading relative isolate flex flex-col gap-4 overflow-hidden rounded-3xl border border-indigo-300/15 bg-gradient-to-br from-indigo-500/[.12] via-slate-900/90 to-violet-500/[.08] p-5 shadow-[0_24px_70px_rgba(0,0,0,.28)] sm:flex-row sm:items-center sm:justify-between sm:p-7 [&>p]:inline-flex [&>p]:w-fit [&>p]:items-center [&>p]:gap-2 [&>p]:rounded-xl [&>p]:border [&>p]:border-white/10 [&>p]:bg-slate-950/45 [&>p]:px-3.5 [&>p]:py-2.5 [&>p]:shadow-inner [&>p]:shadow-black/20 [&>p]:backdrop-blur">
      <div aria-hidden="true" className="pointer-events-none absolute -right-12 -top-20 -z-10 h-64 w-64 rounded-full bg-indigo-400/15 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-28 left-1/3 -z-10 h-52 w-52 rounded-full bg-violet-400/10 blur-3xl" />
      <div className="flex items-center gap-4"><span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-indigo-200/20 bg-indigo-300/10 text-indigo-100 shadow-[inset_0_1px_0_rgba(255,255,255,.1),0_0_32px_rgba(129,140,248,.12)]"><ArrowLeftRight size={21} /></span><h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Subrole changes</h1></div>
      <p className="inline-flex w-fit items-center gap-2 rounded-xl border border-white/10 bg-slate-950/45 px-3.5 py-2.5 text-xs text-slate-300 shadow-inner shadow-black/20 backdrop-blur"><CalendarDays size={15} className="text-indigo-200" /><span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Cutoff</span><span className="font-semibold text-slate-200">{data ? `${dateLabel(data.nextChangeAt, { month: 'short', day: 'numeric', year: 'numeric' })} · 12 AM EST` : 'Loading…'}</span></p>
    </header>

    {error && <p role="alert" className="flex items-start gap-2 rounded-xl border border-rose-400/20 bg-rose-400/5 px-4 py-3 text-sm text-rose-200"><CircleAlert size={16} className="mt-0.5 shrink-0" />{error}</p>}
    {notice && <p role="status" className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-4 py-3 text-sm text-emerald-200"><Check size={16} />{notice}</p>}

    {data?.canApprove && <section className="relative overflow-hidden rounded-3xl border border-amber-300/20 bg-gradient-to-br from-amber-300/[.09] via-slate-900/90 to-slate-950/80 shadow-xl shadow-black/20" aria-labelledby="approval-queue-title">
      <div aria-hidden="true" className="pointer-events-none absolute -right-12 -top-20 h-56 w-56 rounded-full bg-amber-200/[.08] blur-3xl" />
      <header className="relative flex items-center justify-between gap-3 border-b border-white/[.07] px-4 py-4 sm:px-5"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl border border-amber-200/20 bg-amber-200/[.08] text-amber-100"><ShieldCheck size={19} /></span><div><h2 id="approval-queue-title" className="text-sm font-bold text-white">Approvals</h2><p className="mt-0.5 text-[10px] text-slate-500">Review subrole requests</p></div></div><span className="grid min-h-8 min-w-8 place-items-center rounded-full border border-amber-200/20 bg-amber-200/10 px-2 text-xs font-bold tabular-nums text-amber-100">{pendingRequests.length}</span></header>
      {loading ? <div className="p-4"><LoadingSurface rows={1} label="Loading approvals" /></div> : pendingRequests.length === 0 ? <div className="m-3 rounded-2xl border border-dashed border-white/10 bg-slate-950/25 px-4 py-8 text-center sm:m-4"><ShieldCheck size={21} className="mx-auto text-slate-600" /><p className="mt-2 text-xs font-medium text-slate-400">No pending requests</p></div> : <div className="grid gap-2.5 p-3 sm:p-4">{pendingRequests.map((toon) => {
        const request = toon.request!;
        const busyDeny = busyKey === `deny:${request.id}`;
        const busyApprove = busyKey === `approve:${request.id}`;
        return <article key={request.id} className="group rounded-2xl border border-white/[.07] bg-slate-950/55 p-3.5 shadow-lg shadow-black/10 transition duration-200 hover:-translate-y-px hover:border-amber-200/20 hover:bg-slate-950/75 sm:p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-2">
              <p className="truncate text-sm font-semibold tracking-wide text-white">{toon.account || 'Unnamed toon'}</p>
              <div className="flex flex-wrap items-center gap-2">
                <RoleBadge role={toon.currentRole} gameClass />
                <span className="grid h-6 w-6 place-items-center rounded-full border border-white/[.07] bg-white/[.025] text-slate-500"><ArrowRight size={12} /></span>
                <RoleBadge role={request.requestedRole} gameClass />
              </div>
            </div>
            <div className="flex shrink-0 justify-end gap-2">
              <button type="button" disabled={Boolean(busyKey)} onClick={() => void mutate('deny', toon, request.id)} className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-rose-300/15 bg-rose-400/[.04] px-3.5 text-xs font-semibold text-rose-200 transition hover:border-rose-300/35 hover:bg-rose-400/10 disabled:cursor-wait disabled:opacity-45">{busyDeny ? <LoaderCircle size={14} className="animate-spin" /> : <><X size={14} />Deny</>}</button>
              <button type="button" disabled={Boolean(busyKey)} onClick={() => void mutate('approve', toon, request.id)} className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-green-600 px-4 text-xs font-bold text-white shadow-lg shadow-emerald-950/30 transition hover:from-emerald-500 hover:to-green-500 hover:shadow-emerald-900/30 disabled:cursor-wait disabled:opacity-45">{busyApprove ? <LoaderCircle size={14} className="animate-spin" /> : <><Check size={14} />Approve</>}</button>
            </div>
          </div>
        </article>;
      })}</div>}
    </section>}

    <section className="overflow-hidden rounded-3xl border border-white/[.07] bg-gradient-to-br from-slate-900/75 via-slate-950/50 to-slate-950/80 shadow-xl shadow-black/15" aria-labelledby="active-toons-title">
      <header className="flex items-center justify-between gap-3 border-b border-white/[.07] px-4 py-4 sm:px-5"><div><p className="page-kicker">Subroles</p><h2 id="active-toons-title" className="mt-1 text-sm font-bold text-white">{data?.canApprove ? 'Your toons & open changes' : 'Your toons'}</h2></div>{!loading && <span className="rounded-full border border-white/[.08] bg-white/[.03] px-2.5 py-1 text-[10px] font-semibold tabular-nums text-slate-400">{orderedToons.length}</span>}</header>
      {loading ? <LoadingSurface rows={4} label="Loading toons" /> : orderedToons.length === 0 ? (
        <div className="m-3 rounded-2xl border border-dashed border-white/10 bg-slate-950/25 px-4 py-10 text-center text-xs font-medium text-slate-400 sm:m-4">{data?.canApprove ? 'No open changes' : 'No linked toons'}</div>
      ) : <div className="grid gap-2.5 p-3 sm:p-4">{orderedToons.map((toon) => {
        const request = toon.request;
        const pending = request?.status === 'pending';
        const scheduled = request?.status === 'approved';
        const alternateRole = getAlternateToonSubrole(toon.currentRole);
        const canSubmitRequest = toon.canRequest && Boolean(alternateRole) && !toon.duplicateIdentity;
        const busy = busyKey === `request:${toon.rowIndex}` || busyKey === `cancel:${request?.id}`;
        return <article key={toon.rowIndex} className="group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-white/[.06] bg-slate-950/35 p-3.5 transition duration-200 hover:border-indigo-300/20 hover:bg-slate-950/65 sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <div className="min-w-0"><h3 className="truncate text-sm font-medium text-white">{toon.account || 'Unnamed toon'}</h3><div className="mt-2 flex flex-wrap items-center gap-2"><RoleBadge role={toon.currentRole} gameClass />{request && <><ArrowRight size={12} className="text-slate-500" /><RoleBadge role={request.requestedRole} gameClass /><span className={`rounded-full border px-2 py-1 text-[9px] font-semibold ${pending ? 'border-amber-200/15 bg-amber-200/[.06] text-amber-100' : 'border-indigo-200/15 bg-indigo-200/[.06] text-indigo-100'}`}>{pending ? 'Pending' : `Starts ${dateLabel(request.effectiveAt, { month: 'short', day: 'numeric' })}`}</span></>}</div></div>
          <div className="flex shrink-0 items-center gap-2">
            {toon.duplicateIdentity ? <span className="text-xs text-amber-200">Duplicate toon</span>
              : pending && request && toon.canCancel && !data?.canApprove ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void mutate('cancel', toon, request.id)} className="inline-flex min-h-10 items-center justify-center rounded-xl border border-white/10 bg-white/[.025] px-3.5 text-xs font-semibold text-slate-300 transition hover:border-rose-300/25 hover:bg-rose-400/[.06] hover:text-rose-100 disabled:opacity-45">{busy ? <LoaderCircle size={14} className="animate-spin" /> : 'Cancel request'}</button>
              : scheduled && request && toon.canCancel ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void mutate('cancel', toon, request.id)} className="inline-flex min-h-10 items-center justify-center rounded-xl border border-white/10 bg-white/[.025] px-3.5 text-xs font-semibold text-slate-300 transition hover:border-rose-300/25 hover:bg-rose-400/[.06] hover:text-rose-100 disabled:opacity-45">{busy ? <LoaderCircle size={14} className="animate-spin" /> : 'Cancel change'}</button>
              : !request && canSubmitRequest ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void mutate('request', toon)} className="primary-button disabled:cursor-wait disabled:opacity-45">{busy ? <LoaderCircle size={14} className="animate-spin" /> : <><ArrowLeftRight size={14} />Request {alternateRole}</>}</button>
              : null}
          </div>
        </article>;
      })}</div>}
    </section>
  </div>;
}
