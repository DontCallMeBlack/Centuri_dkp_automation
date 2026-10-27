'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import LoadingSurface from '@/components/LoadingSurface';
import { useSessionUser } from '@/components/AppShell';
import { ApiError, clientDataVersion, clearClientData, getData, peekData, notifyDkpChanged, readResponse } from '@/lib/client/api';
import { getActionRequestId, completeActionRequest } from '@/lib/client/actionRequests';
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

interface HistoryData {canManage:boolean; awards:BossAward[]; roster:RosterMember[]; nextCursor?:string|null}

export default function BossHistoryPanel({ embedded = false, active = true }: { embedded?: boolean; active?: boolean }) {
  const user = useSessionUser();
  const initialHistory = peekData<HistoryData>('/api/admin/boss-history');
  const mountedRef = useRef(true);
  const [refreshing, setRefreshing] = useState(false);
  const [awards, setAwards] = useState<BossAward[]>(() => initialHistory?.awards ?? []);
  const [roster, setRoster] = useState<RosterMember[]>(() => initialHistory?.roster ?? []);
  const [selectedRows, setSelectedRows] = useState<Record<string, number[]>>(() => Object.fromEntries((initialHistory?.awards ?? []).map((award) => [award.id, award.selectedRows])));
  const [editingId, setEditingId] = useState('');
  const editingRef = useRef('');
  editingRef.current = editingId;
  const [loading, setLoading] = useState(() => !initialHistory);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [accessDenied, setAccessDenied] = useState(false);
  const [canManage, setCanManage] = useState(() => initialHistory?.canManage === true);
  const [nextCursor, setNextCursor] = useState<string | null>(() => initialHistory?.nextCursor ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageCount = useRef(1);
  const historySequence = useRef(0);
  const historyPending = useRef(0);
  const initialLoadStarted = useRef(Boolean(initialHistory));
  const router = useRouter();

  const applyData = useCallback((data:HistoryData) => {
    setCanManage(data.canManage === true); setAwards(data.awards); setRoster(data.roster); setNextCursor(data.nextCursor ?? null);
    setSelectedRows((previous) => ({...Object.fromEntries(data.awards.map((award) => [award.id,award.selectedRows])),...(editingRef.current ? {[editingRef.current]:previous[editingRef.current]} : {})}));
  }, []);
  const loadHistory = useCallback(async (clearReadError = true) => {
    if (!mountedRef.current || historyPending.current) return;
    const version = clientDataVersion();
    const sequence = ++historySequence.current;
    historyPending.current = sequence;
    setRefreshing(true);
    try {
      const data = await getData<HistoryData>('/api/admin/boss-history');
      const combined = [...data.awards];
      let cursor = data.nextCursor;
      for (let page = 1; page < pageCount.current && cursor; page += 1) {
        if (version !== clientDataVersion() || sequence !== historySequence.current) return;
        const older = await getData<HistoryData>(`/api/admin/boss-history?cursor=${encodeURIComponent(cursor)}`);
        combined.push(...older.awards); cursor = older.nextCursor;
      }
      if (mountedRef.current && version === clientDataVersion() && sequence === historySequence.current) {
        applyData({ ...data, awards: [...new Map(combined.map((award) => [award.id, award])).values()], nextCursor: cursor });
        setAccessDenied(false); if (clearReadError) setError('');
      }
    }
    catch (cause) {
      if (!mountedRef.current || version !== clientDataVersion() || sequence !== historySequence.current) return;
      if (cause instanceof ApiError && cause.status === 401) { clearClientData(); router.replace('/login'); }
      else if (cause instanceof ApiError && cause.status === 403) setAccessDenied(true);
      else setError(cause instanceof Error ? cause.message : 'Boss history could not be refreshed. Showing the last known data.');
      return false;
    } finally { if (historyPending.current === sequence) historyPending.current = 0; if (mountedRef.current && version === clientDataVersion() && sequence === historySequence.current) { setLoading(false); setRefreshing(false); } }
  }, [applyData, router]);
  useEffect(() => {
    mountedRef.current=true;
    const clear = () => { initialLoadStarted.current = false; historySequence.current += 1; historyPending.current = 0; pageCount.current = 1; setNextCursor(null); setLoadingMore(false); setRefreshing(false); setAwards([]); setRoster([]); setSelectedRows({}); setEditingId(''); setCanManage(false); setLoading(true); };
    window.addEventListener('centuri:clear-data', clear);
    return () => { mountedRef.current=false; window.removeEventListener('centuri:clear-data', clear); };
  }, []);
  useEffect(() => {
    if (!active || initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void loadHistory();
  }, [active, loadHistory]);
  useEffect(() => {
    if (!active) return;
    const reloadForSessionChange = () => { initialLoadStarted.current = true; void loadHistory(); };
    window.addEventListener('centuri:session-updated', reloadForSessionChange);
    return () => window.removeEventListener('centuri:session-updated', reloadForSessionChange);
  }, [active, loadHistory]);

  const loadMoreHistory = async () => {
    if (!nextCursor || loadingMore || refreshing || historyPending.current) return;
    const sequence = ++historySequence.current;
    historyPending.current = sequence;
    const version = clientDataVersion();
    setLoadingMore(true);
    try {
      const data = await getData<HistoryData>(`/api/admin/boss-history?cursor=${encodeURIComponent(nextCursor)}`);
      if (!mountedRef.current || version !== clientDataVersion() || sequence !== historySequence.current) return;
      const combined = [...new Map([...awards, ...data.awards].map((award) => [award.id, award])).values()];
      pageCount.current += 1; applyData({ ...data, awards: combined });
    } catch (cause) { if (mountedRef.current && version === clientDataVersion() && sequence === historySequence.current) setError(cause instanceof Error ? cause.message : 'Older kills could not be loaded.'); }
    finally { if (historyPending.current === sequence) historyPending.current = 0; if (version === clientDataVersion() && sequence === historySequence.current) setLoadingMore(false); }
  };

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
    const previousAwards = awards;
    const nextSelectedRows = selectedRows[awardId] ?? [];
    const nextParticipants = roster.filter((member) => nextSelectedRows.includes(member.rowIndex));
    setAwards((current) => current.map((entry) => entry.id === awardId
      ? { ...entry, status: 'updating', selectedRows: nextSelectedRows, participants: nextParticipants }
      : entry));
    setBusyId(awardId);
    setError('');
    setNotice('Saving attendance and syncing DKP…');
    try {
      if (!user?.id) throw new Error('Your session is still loading. Try again in a moment.');
      const requestId = await getActionRequestId(user.id, 'boss-history', payloadKey);
      const response = await fetch('/api/admin/boss-history', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ awardId, requestId, selectedRows: selectedRows[awardId] ?? [] }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to update boss attendance');
      await completeActionRequest(user.id, 'boss-history', payloadKey);
      setNotice(data.message);
      setEditingId(''); editingRef.current='';
      notifyDkpChanged();
    } catch (saveError) {
      setAwards(previousAwards);
      setNotice('');
      setError(saveError instanceof Error ? saveError.message : 'Unable to update boss attendance');
      await loadHistory(false);
    } finally {
      setBusyId('');
    }
  };

  const deleteAward = async (award: BossAward) => {
    if (!window.confirm(
      `Delete the ${award.bossName} kill? This removes ${award.points} DKP from each participant still on the roster. Removed toons are skipped because their DKP was already forfeited. This cannot be undone.`,
    )) {
      return;
    }

    const payloadKey = JSON.stringify({kind:'delete',awardId:award.id});
    const previousAwards = awards;
    setAwards((current) => current.map((entry) => entry.id === award.id ? { ...entry, status: 'updating' } : entry));
    setBusyId(award.id);
    setError('');
    setNotice('Removing this kill and syncing DKP…');
    try {
      if (!user?.id) throw new Error('Your session is still loading. Try again in a moment.');
      const requestId = await getActionRequestId(user.id, 'boss-history', payloadKey);
      const response = await fetch('/api/admin/boss-history', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ awardId: award.id, requestId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to delete boss kill');
      await completeActionRequest(user.id, 'boss-history', payloadKey);
      setNotice(data.message);
      setEditingId(''); editingRef.current='';
      notifyDkpChanged();
    } catch (deleteError) {
      setAwards(previousAwards);
      setNotice('');
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete boss kill');
      await loadHistory(false);
    } finally {
      setBusyId('');
    }
  };

  const resumeAward = async (award: BossAward) => {
    setBusyId(award.id); setError(''); setNotice('Resuming the pending DKP update…');
    const change = award.pendingChange;
    try {
      const result = await readResponse<{message:string}>(await fetch(change ? '/api/admin/boss-history' : '/api/dkp', {
        method: change ? change.kind === 'delete' ? 'DELETE' : 'PATCH' : 'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(change ? {awardId:award.id,requestId:change.requestId,selectedRows:change.selectedRows} : {requestId:award.requestId,bossName:award.bossName,selectedRows:award.originalSelectedRows}),
      }));
      if (user?.id) {
        const payload = change
          ? JSON.stringify(change.kind === 'delete' ? {kind:'delete',awardId:award.id} : {kind:'edit',awardId:award.id,selectedRows:[...change.selectedRows].sort((a,b)=>a-b)})
          : JSON.stringify({bossName:award.bossName,selectedRows:[...award.originalSelectedRows].sort((a,b)=>a-b)});
        await completeActionRequest(user.id, change ? 'boss-history' : 'boss-award', payload);
      }
      setNotice(result.message); notifyDkpChanged();
    } catch (cause) { setNotice(''); setError(cause instanceof Error ? cause.message : 'The operation could not be confirmed.'); await loadHistory(false); }
    finally { setBusyId(''); }
  };

  if (loading) return <LoadingSurface fullLayout label="Preparing boss history" title="Every kill. Every contribution." />;

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
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p className="page-kicker">The raid record</p><h1 className="page-title">Every kill. Every contribution.</h1><p className="page-description">{canManage ? 'Review boss rewards and keep attendance accurate.' : 'Explore your clan boss kills and attendance.'}</p></div></div>
      <div className="space-y-4">
        <p className="text-sm text-slate-400">
          {canManage
            ? 'Add or remove attendees to adjust the award. Deleting a kill reverses its DKP for every attendee.'
            : 'Boss history is view-only. Only Chiefs, Generals, and Guardians can change records.'}
        </p>
        {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}
        {notice && <p role="status" aria-live="polite" className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm ${busyId ? 'border border-indigo-400/20 bg-indigo-500/10 text-indigo-200' : 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300'}`}>{busyId && <LoaderCircle size={15} className="animate-spin" />}{notice}</p>}

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
                      {busyId === award.id ? 'Saving changes…' : 'Save changes'}
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
        {nextCursor && <button type="button" className="secondary-button w-full" disabled={loadingMore || refreshing} onClick={() => void loadMoreHistory()}>{loadingMore ? <LoaderCircle size={15} className="animate-spin" /> : <History size={15} />}Load older kills</button>}
      </div>
    </section>
  );
}
