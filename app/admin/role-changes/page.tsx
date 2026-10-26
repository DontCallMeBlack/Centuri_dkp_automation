'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, CircleAlert, LoaderCircle } from 'lucide-react';
import LoadingSurface from '@/components/LoadingSurface';
import RoleBadge from '@/components/RoleBadge';
import { useSessionUser } from '@/components/AppShell';
import { ApiError, clearClientData, getData, invalidateData, notifyDkpChanged, readResponse } from '@/lib/client/api';
import { getAlternateToonSubrole } from '@/lib/auctionRules';
import { ROLE_CHANGE_TIME_ZONE } from '@/lib/toonRoleChanges';
import { useAutoRefresh } from '@/lib/client/useAutoRefresh';

type RequestStatus = 'pending' | 'approved';
interface ToonRequest {
  id: string;
  status: RequestStatus;
  requestedRole: string;
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
  const [data, setData] = useState<RoleChangeData | null>(null);
  const [loading, setLoading] = useState(true);
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
    const clear = () => { setData(null); setLoading(true); setBusyKey(''); setError(''); setNotice(''); };
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

  const pendingRequests = data?.toons.filter((toon) => toon.request?.status === 'pending') ?? [];
  const visibleToons = data?.toons ?? [];
  const orderedToons = data?.canApprove
    ? [...visibleToons].sort((first, second) => Number(second.request?.status === 'pending') - Number(first.request?.status === 'pending') || first.rowIndex - second.rowIndex)
    : visibleToons;

  return <div className="mx-auto max-w-4xl space-y-4">
    <header className="flex flex-wrap items-end justify-between gap-2 border-b border-white/[.08] pb-4">
      <h1 className="text-2xl font-semibold text-white">Subrole changes</h1>
      <p className="text-xs text-slate-400">Next cutoff: {data ? `${dateLabel(data.nextChangeAt, { month: 'short', day: 'numeric', year: 'numeric' })} · 12:00 AM EST` : 'Loading…'}</p>
    </header>

    {error && <p role="alert" className="flex items-start gap-2 rounded-xl border border-rose-400/20 bg-rose-400/5 px-4 py-3 text-sm text-rose-200"><CircleAlert size={16} className="mt-0.5 shrink-0" />{error}</p>}
    {notice && <p role="status" className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-4 py-3 text-sm text-emerald-200"><Check size={16} />{notice}</p>}

    {data?.canApprove && <section className="rounded-2xl border border-amber-300/15 bg-amber-300/[.035] p-4" aria-labelledby="approval-queue-title">
      <div className="mb-3 flex items-center justify-between gap-2"><h2 id="approval-queue-title" className="text-sm font-semibold text-white">Approvals</h2><span className="text-xs text-amber-100">{pendingRequests.length}</span></div>
      {loading ? <LoadingSurface rows={1} label="Loading approvals" /> : pendingRequests.length === 0 ? <p className="text-xs text-slate-500">No pending requests.</p> : <div className="divide-y divide-white/[.06]">{pendingRequests.map((toon) => {
        const request = toon.request!;
        const busy = busyKey === request.id;
        return <article key={request.id} className="rounded-xl border border-white/[.07] bg-slate-950/40 p-3 transition-colors hover:border-indigo-300/20 sm:p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-2">
              <p className="truncate text-sm font-semibold text-white">{toon.account || 'Unnamed toon'}</p>
              <div className="flex flex-wrap items-center gap-2">
                <RoleBadge role={toon.currentRole} gameClass />
                <ArrowRight size={14} className="text-slate-500" />
                <RoleBadge role={request.requestedRole} gameClass />
              </div>
            </div>
            <div className="flex shrink-0 justify-end gap-2">
              <button type="button" disabled={Boolean(busyKey)} onClick={() => void mutate('deny', toon, request.id)} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-rose-400/40 hover:bg-rose-400/[.06] disabled:opacity-50">{busy ? <LoaderCircle size={14} className="animate-spin" /> : 'Deny'}</button>
              <button type="button" disabled={Boolean(busyKey)} onClick={() => void mutate('approve', toon, request.id)} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50">{busy ? <LoaderCircle size={14} className="animate-spin" /> : 'Approve'}</button>
            </div>
          </div>
        </article>;
      })}</div>}
    </section>}

    <section aria-labelledby="active-toons-title">
      <h2 id="active-toons-title" className="mb-2 text-sm font-semibold text-slate-300">Active toons</h2>
      {loading ? <LoadingSurface rows={4} label="Loading toons" /> : orderedToons.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 p-6 text-sm text-slate-500">No linked toons.</div>
      ) : <div className="divide-y divide-white/[.08]">{orderedToons.map((toon) => {
        const request = toon.request;
        const pending = request?.status === 'pending';
        const scheduled = request?.status === 'approved';
        const alternateRole = getAlternateToonSubrole(toon.currentRole);
        const canSubmitRequest = toon.canRequest && Boolean(alternateRole) && !toon.duplicateIdentity;
        const busy = busyKey === (request?.id ?? `request:${toon.rowIndex}`);
        return <article key={toon.rowIndex} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0"><h3 className="truncate text-sm font-medium text-white">{toon.account || toon.owner}</h3><p className="mt-1 text-xs text-slate-500">{toon.owner}</p><div className="mt-2 flex flex-wrap items-center gap-2"><RoleBadge role={toon.currentRole} gameClass />{request && <><ArrowRight size={12} className="text-slate-500" /><RoleBadge role={request.requestedRole} gameClass /><span className="text-[10px] text-slate-500">{pending ? 'Pending' : `Starts ${dateLabel(request.effectiveAt, { month: 'short', day: 'numeric' })}${request.decidedByNickname ? ` · approved by ${request.decidedByNickname}` : ''}`}</span></>}</div></div>
          <div className="flex shrink-0 items-center gap-2">
            {toon.duplicateIdentity ? <span className="text-xs text-amber-200">Duplicate toon</span>
              : pending && request && toon.canCancel && !data?.canApprove ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void mutate('cancel', toon, request.id)} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 disabled:opacity-50">{busy ? <LoaderCircle size={14} className="animate-spin" /> : 'Cancel request'}</button>
              : scheduled && request && toon.canCancel ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void mutate('cancel', toon, request.id)} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 disabled:opacity-50">{busy ? <LoaderCircle size={14} className="animate-spin" /> : 'Cancel change'}</button>
              : !request && canSubmitRequest ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void mutate('request', toon)} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy ? <LoaderCircle size={14} className="animate-spin" /> : `Request ${alternateRole}`}</button>
              : !request && toon.canRequest && !alternateRole ? <span className="text-xs text-slate-500">No alternate subrole</span>
              : null}
          </div>
        </article>;
      })}</div>}
    </section>
  </div>;
}
