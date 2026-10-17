'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import LoadingSurface from '@/components/LoadingSurface';
import { useSessionUser } from '@/components/AppShell';
import { ApiError, clearClientData, getData, peekData, notifyDkpChanged, readResponse } from '@/lib/client/api';
import { Check, History, LoaderCircle, Save, Shield, Trash2, Users, X } from 'lucide-react';

interface RosterMember {
  rowIndex: number;
  owner: string;
  account: string;
}

interface BossAward {
  id: string;
  requestId?: string;
  originalSelectedRows: number[];
  pendingChange?: {requestId: string; kind: 'edit' | 'delete'; selectedRows: number[]};
  bossName: string;
  points: number;
  participants: RosterMember[];
  selectedRows: number[];
  createdBy: string;
  updatedBy?: string;
  status: 'pending' | 'applied' | 'failed' | 'updating';
  failureReason?: string;
  createdAt: string;
}

interface HistoryData {canManage:boolean; awards:BossAward[]; roster:RosterMember[]}

export default function BossHistoryPanel({ embedded = false }: { embedded?: boolean }) {
  const user = useSessionUser();
  const mountedRef = useRef(true);
  const requestIds = useRef(new Map<string, string>());
  const [refreshing, setRefreshing] = useState(false);
  const [awards, setAwards] = useState<BossAward[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [selectedRows, setSelectedRows] = useState<Record<string, number[]>>({});
  const [editingId, setEditingId] = useState('');
  const editingRef = useRef('');
  editingRef.current = editingId;
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [accessDenied, setAccessDenied] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const router = useRouter();

  const applyData = (data:HistoryData) => {
    setCanManage(data.canManage === true); setAwards(data.awards); setRoster(data.roster);
    setSelectedRows((previous) => ({...Object.fromEntries(data.awards.map((award) => [award.id,award.selectedRows])),...(editingRef.current ? {[editingRef.current]:previous[editingRef.current]} : {})}));
  };
  const loadHistory = async () => {
    if (!mountedRef.current) return;
    setRefreshing(true);
    try { const data=await getData<HistoryData>('/api/admin/boss-history'); if (mountedRef.current) { applyData(data); setAccessDenied(false); } }
    catch (cause) {
      if (!mountedRef.current) return;
      if (cause instanceof ApiError && cause.status === 401) { clearClientData(); router.replace('/login'); }
      else if (cause instanceof ApiError && cause.status === 403) setAccessDenied(true);
      else setError(cause instanceof Error ? cause.message : 'Boss history could not be refreshed. Showing the last known data.');
    } finally { if (mountedRef.current) { setLoading(false); setRefreshing(false); } }
  };
  useEffect(() => {
    mountedRef.current=true;
    const cached=peekData<HistoryData>('/api/admin/boss-history');
    if (cached) { applyData(cached); setLoading(false); }
    void loadHistory();
    const update=() => { if (document.visibilityState === 'visible') void loadHistory(); };
    window.addEventListener('centuri:dkp-changed',update);
    document.addEventListener('visibilitychange',update);
    return () => { mountedRef.current=false; window.removeEventListener('centuri:dkp-changed',update); document.removeEventListener('visibilitychange',update); };
  }, []);

  const toggleRow = (awardId: string, rowIndex: number) => {
    setSelectedRows((current) => {
      const rows = current[awardId] ?? [];
      return {
        ...current,
        [awardId]: rows.includes(rowIndex)
          ? rows.filter((selected) => selected !== rowIndex)
          : [...rows, rowIndex],
      };
    });
  };

  const saveAttendance = async (awardId: string) => {
    const award = awards.find((entry) => entry.id === awardId);
    const currentRows = new Set(award?.selectedRows ?? []);
    const nextRows = selectedRows[awardId] ?? [];
    const removals = [...currentRows].filter((rowIndex) => !nextRows.includes(rowIndex)).length;
    if (
      removals > 0 &&
      !window.confirm(`This reverses ${award?.points ?? 0} DKP per removed toon in the award's original week. Continue?`)
    ) {
      return;
    }

    const payloadKey = JSON.stringify({kind:'edit',awardId,selectedRows:[...(selectedRows[awardId] ?? [])].sort((a,b) => a-b)});
    const requestId = requestIds.current.get(payloadKey) ?? crypto.randomUUID();
    requestIds.current.set(payloadKey, requestId);
    setBusyId(awardId);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/admin/boss-history', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ awardId, requestId, selectedRows: selectedRows[awardId] ?? [] }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to update boss attendance');
      requestIds.current.delete(payloadKey);
      setNotice(data.message);
      setEditingId(''); editingRef.current='';
      notifyDkpChanged();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to update boss attendance');
      await loadHistory();
    } finally {
      setBusyId('');
    }
  };

  const deleteAward = async (award: BossAward) => {
    if (!window.confirm(
      `Delete the ${award.bossName} kill? This removes ${award.points} DKP from each of its ${award.participants.length} toon(s) and cannot be undone.`,
    )) {
      return;
    }

    const payloadKey = JSON.stringify({kind:'delete',awardId:award.id});
    const requestId = requestIds.current.get(payloadKey) ?? crypto.randomUUID();
    requestIds.current.set(payloadKey, requestId);
    setBusyId(award.id);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/admin/boss-history', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ awardId: award.id, requestId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to delete boss kill');
      requestIds.current.delete(payloadKey);
      setNotice(data.message);
      setEditingId(''); editingRef.current='';
      notifyDkpChanged();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete boss kill');
      await loadHistory();
    } finally {
      setBusyId('');
    }
  };

  const resumeAward = async (award: BossAward) => {
    setBusyId(award.id); setError(''); setNotice('');
    const change = award.pendingChange;
    try {
      const result = await readResponse<{message:string}>(await fetch(change ? '/api/admin/boss-history' : '/api/dkp', {
        method: change ? change.kind === 'delete' ? 'DELETE' : 'PATCH' : 'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(change ? {awardId:award.id,requestId:change.requestId,selectedRows:change.selectedRows} : {requestId:award.requestId,bossName:award.bossName,selectedRows:award.originalSelectedRows}),
      }));
      setNotice(result.message); notifyDkpChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The operation could not be confirmed.'); await loadHistory(); }
    finally { setBusyId(''); }
  };

  if (loading) return <LoadingSurface label="Preparing boss history" />;

  if (accessDenied) {
    return (
      <section className="surface flex min-h-80 items-center justify-center px-5 text-slate-100">
        <section className="w-full max-w-md border-y border-slate-800 py-8 text-center">
          <Shield className="mx-auto h-8 w-8 text-amber-300" />
          <h1 className="mt-4 text-lg font-bold text-white">Clan member access required</h1>
          <button onClick={() => router.push('/dashboard')} className="mt-5 rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">
            Back to dashboard
          </button>
        </section>
      </section>
    );
  }

  return (
    <section className="space-y-5 text-slate-100">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p className="page-kicker">The raid record</p><h1 className="page-title">Every kill. Every contribution.</h1><p className="page-description">{canManage ? 'Review boss rewards and keep attendance accurate.' : 'Explore your clan boss kills and attendance.'}</p></div><button type="button" className="secondary-button" disabled={refreshing || Boolean(busyId)} onClick={() => void loadHistory()}><History size={14} />{refreshing ? 'Refreshing...' : 'Refresh history'}</button></div>
      <div className="space-y-4">
        <p className="text-sm text-slate-400">
          {canManage
            ? 'Add or remove attendees to adjust the award. Deleting a kill reverses its DKP for every attendee.'
            : 'Boss history is view-only. Only Chiefs, Generals, and Guardians can change records.'}
        </p>
        {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}
        {notice && <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>}

        {awards.length === 0 ? (
          <section className="border-y border-slate-800 py-12 text-center">
            <History className="mx-auto h-7 w-7 text-slate-600" />
            <p className="mt-3 text-sm text-slate-400">No boss awards have been logged yet.</p>
          </section>
        ) : awards.map((award) => {
          const isEditing = editingId === award.id;
          const selectedCount = selectedRows[award.id]?.length ?? 0;
          return (
            <article key={award.id} className="surface p-5 sm:p-6">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-bold text-white">{award.bossName}</h2>
                    <span className="rounded-full bg-indigo-500/10 px-2.5 py-1 text-xs font-semibold text-indigo-300">
                      +{award.points} DKP
                    </span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${award.status === 'applied' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}>
                      {award.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {new Date(award.createdAt).toLocaleString()} · Recorded by {award.createdBy}
                    {award.updatedBy ? ` · Last edited by ${award.updatedBy}` : ''}
                  </p>
                </div>
                {canManage && award.status === 'applied' && !isEditing && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setEditingId(award.id)}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-indigo-500/40 px-3 py-2 text-sm font-semibold text-indigo-200 hover:bg-indigo-500/10"
                    >
                      <Users className="h-4 w-4" /> Edit toons
                    </button>
                    <button
                      onClick={() => void deleteAward(award)}
                      disabled={busyId === award.id}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-500/40 px-3 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busyId === award.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      Delete kill
                    </button>
                  </div>
                )}
              </div>

              {canManage && ((award.status === 'updating' && award.pendingChange) || (award.status === 'pending' && award.requestId && (award.createdBy === user?.nickname || ['chief','general'].includes(user?.role ?? '')))) && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3"><p className="text-xs text-amber-200">This operation needs to finish before this record can be changed.</p><button type="button" disabled={Boolean(busyId)} onClick={() => void resumeAward(award)} className="secondary-button">{busyId === award.id ? <LoaderCircle size={14} className="animate-spin" /> : <History size={14} />}Resume {award.pendingChange?.kind || 'award'}</button></div>}
              {award.status !== 'applied' && award.failureReason && (
                <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{award.failureReason}</p>
              )}

              {canManage && isEditing ? (
                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
                    <span>Select who should receive this boss award; clear all to reverse it for everyone.</span>
                    <span>{selectedCount} selected</span>
                  </div>
                  <div className="grid max-h-72 grid-cols-1 gap-x-3 overflow-y-auto rounded-lg border border-slate-800 p-2 sm:grid-cols-2">
                    {roster.map((record) => {
                      const isSelected = (selectedRows[award.id] ?? []).includes(record.rowIndex);
                      return (
                        <label
                          key={record.rowIndex}
                          className={`flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm transition ${
                            isSelected
                              ? 'border-indigo-400/40 bg-indigo-500/10 text-white shadow-sm shadow-indigo-950/30'
                              : 'border-slate-800/80 bg-slate-950/40 text-slate-300 hover:border-slate-700 hover:bg-slate-800/60'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleRow(award.id, record.rowIndex)}
                            className="peer sr-only"
                          />
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-slate-600 bg-slate-900 text-white transition peer-checked:border-indigo-400 peer-checked:bg-indigo-500 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-300 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-950">
                            <Check className={`h-3.5 w-3.5 transition ${isSelected ? 'opacity-100' : 'opacity-0'}`} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold">{record.account || 'Unnamed toon'}</span>
                            <span className="mt-0.5 block truncate text-xs text-slate-500">{record.owner}</span>
                          </span>
                        </label>
                      );
                    })}
                    {roster.length === 0 && <p className="px-2 py-3 text-sm text-slate-500">No roster records found.</p>}
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      onClick={() => {
                        setSelectedRows((current) => ({
                          ...current,
                          [award.id]: award.selectedRows,
                        }));
                        setEditingId('');
                      }}
                      disabled={busyId === award.id}
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      <X className="h-4 w-4" /> Cancel
                    </button>
                    <button
                      onClick={() => void saveAttendance(award.id)}
                      disabled={busyId === award.id}
                      className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {busyId === award.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      Save changes
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-4 border-t border-slate-800 pt-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Participants · {award.participants.length}
                  </p>
                  {award.participants.length === 0 ? (
                    <p className="mt-2 text-sm text-slate-500">No toons currently receive this award.</p>
                  ) : (
                    <p className="mt-2 text-sm text-slate-300">
                      {award.participants.map((participant) => participant.account || participant.owner).join(', ')}
                    </p>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
