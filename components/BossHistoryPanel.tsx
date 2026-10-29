'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import LoadingSurface from '@/components/LoadingSurface';
import RoleBadge from '@/components/RoleBadge';
import BossIcon from '@/components/BossIcon';
import { useSessionUser } from '@/components/AppShell';
import { ApiError, clientDataVersion, clearClientData, getData, peekData, notifyDkpChanged, readResponse } from '@/lib/client/api';
import { getActionRequestId, completeActionRequest } from '@/lib/client/actionRequests';
import { History, LoaderCircle, MessageCircle, Save, Shield, Trash2, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { BOSS_ATTENDANCE_REMOVAL_REASONS, type BossAttendanceRemovalReason } from '@/lib/bossDkp';

interface RosterMember {
  rowIndex: number;
  owner: string;
  account: string;
  subClass?: string;
}

interface BossAward {
  id: string;
  requestId?: string;
  originalSelectedRows: number[];
  pendingChange?: {
    requestId: string;
    kind: 'edit' | 'delete';
    selectedRows: number[];
    removalReasons?: Array<{owner: string; account: string; reason: BossAttendanceRemovalReason}>;
  };
  bossName: string;
  points: number;
  participants: RosterMember[];
  auditTrail?: Array<{
    kind: 'participant_added' | 'participant_removed' | 'kill_deleted';
    changeId?: string;
    participant?: RosterMember;
    reason?: BossAttendanceRemovalReason;
    actor: string;
    occurredAt: string;
  }>;
  selectedRows: number[];
  canModify?: boolean;
  createdBy: string;
  updatedBy?: string;
  status: 'pending' | 'applied' | 'failed' | 'updating';
  failureReason?: string;
  createdAt: string;
}

interface HistoryData {canManage:boolean; awards:BossAward[]; roster:RosterMember[]; nextCursor?:string|null}

const BOSS_ACCENTS: Record<string, string> = {
  Base: 'from-slate-200 via-slate-400 to-slate-700',
  Prime: 'from-yellow-200 via-amber-400 to-orange-700',
  Bt: 'from-lime-300 via-green-400 to-emerald-800',
  Gele: 'from-violet-200 via-purple-400 to-indigo-800',
  Dino: 'from-cyan-200 via-sky-400 to-blue-800',
  Crom: 'from-orange-200 via-amber-500 to-stone-800',
};

function participantKey(participant: Pick<RosterMember, 'owner' | 'account'>) {
  return JSON.stringify([participant.owner.trim().toLowerCase(), participant.account.trim().toLowerCase()]);
}

function getRemovedParticipants(award: BossAward, nextRows: number[], roster: RosterMember[]) {
  const selectedKeys = new Set(roster
    .filter((member) => nextRows.includes(member.rowIndex))
    .map(participantKey));
  return award.participants.filter((participant) => !selectedKeys.has(participantKey(participant)));
}

function sortRemovalReasons(reasons: Array<{owner: string; account: string; reason: BossAttendanceRemovalReason}>) {
  return [...reasons].sort((left, right) =>
    participantKey(left).localeCompare(participantKey(right)) || left.reason.localeCompare(right.reason));
}

type BossAuditEvent = NonNullable<BossAward['auditTrail']>[number];

interface AuditComment {
  id: string;
  actor: string;
  occurredAt: string;
  added: RosterMember[];
  removed: Array<{participant?: RosterMember; reason?: BossAttendanceRemovalReason}>;
  deleted: boolean;
}

function groupAuditComments(events: BossAuditEvent[]) {
  const groups = new Map<string, AuditComment>();
  for (const event of events) {
    const id = event.changeId || `${event.actor}:${event.occurredAt}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, actor: event.actor, occurredAt: event.occurredAt, added: [], removed: [], deleted: false };
      groups.set(id, group);
    }
    if (event.kind === 'participant_added' && event.participant) group.added.push(event.participant);
    else if (event.kind === 'participant_removed') group.removed.push({ participant: event.participant, reason: event.reason });
    else if (event.kind === 'kill_deleted') group.deleted = true;
  }
  return [...groups.values()].reverse();
}

export default function BossHistoryPanel({ embedded = false, active = true }: { embedded?: boolean; active?: boolean }) {
  const user = useSessionUser();
  const initialHistory = peekData<HistoryData>('/api/admin/boss-history');
  const mountedRef = useRef(true);
  const [refreshing, setRefreshing] = useState(false);
  const [awards, setAwards] = useState<BossAward[]>(() => initialHistory?.awards ?? []);
  const [roster, setRoster] = useState<RosterMember[]>(() => initialHistory?.roster ?? []);
  const [selectedRows, setSelectedRows] = useState<Record<string, number[]>>(() => Object.fromEntries((initialHistory?.awards ?? []).map((award) => [award.id, award.selectedRows])));
  const [removalReasons, setRemovalReasons] = useState<Record<string, Record<string, BossAttendanceRemovalReason | ''>>>({});
  const [editingId, setEditingId] = useState('');
  const [commentsOpenId, setCommentsOpenId] = useState('');
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
  const initialLoadStarted = useRef(false);
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
    const clear = () => { initialLoadStarted.current = false; historySequence.current += 1; historyPending.current = 0; pageCount.current = 1; setNextCursor(null); setLoadingMore(false); setRefreshing(false); setAwards([]); setRoster([]); setSelectedRows({}); setRemovalReasons({}); setEditingId(''); setCommentsOpenId(''); setCanManage(false); setLoading(true); };
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
    window.addEventListener('centuri:dkp-changed', reloadForSessionChange);
    return () => {
      window.removeEventListener('centuri:session-updated', reloadForSessionChange);
      window.removeEventListener('centuri:dkp-changed', reloadForSessionChange);
    };
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
    const nextRows = selectedRows[awardId] ?? [];
    const removedParticipants = award ? getRemovedParticipants(award, nextRows, roster) : [];
    const reasonsForRemoval = removedParticipants.map((participant) => ({
      owner: participant.owner,
      account: participant.account,
      reason: removalReasons[awardId]?.[participantKey(participant)],
    }));
    if (reasonsForRemoval.some((entry) => !entry.reason)) {
      setError('Choose a reason for every toon you are removing.');
      return;
    }
    const normalizedRemovalReasons = sortRemovalReasons(reasonsForRemoval as Array<{owner: string; account: string; reason: BossAttendanceRemovalReason}>);
    if (
      removedParticipants.length > 0 &&
      !window.confirm(`Removing ${removedParticipants.length} toon(s) subtracts ${award?.points ?? 0} DKP per affected toon from this week's weekly earned. Participants no longer on the roster are skipped. Continue?`)
    ) {
      return;
    }

    const payloadKey = JSON.stringify({kind:'edit',awardId,selectedRows:[...(selectedRows[awardId] ?? [])].sort((a,b) => a-b),removalReasons:normalizedRemovalReasons});
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
        body: JSON.stringify({ awardId, requestId, selectedRows: selectedRows[awardId] ?? [], removalReasons: normalizedRemovalReasons }),
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
      `Delete the ${award.bossName} kill? This week's award will be reversed by subtracting ${award.points} DKP from weekly earned for each participant still on the roster. Removed toons are skipped because their DKP was already forfeited. This cannot be undone.`,
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
        body: JSON.stringify(change ? {
          awardId:award.id,
          requestId:change.requestId,
          selectedRows:change.selectedRows,
          ...(change.removalReasons !== undefined ? {removalReasons:sortRemovalReasons(change.removalReasons)} : {}),
        } : {requestId:award.requestId,bossName:award.bossName,selectedRows:award.originalSelectedRows}),
      }));
      if (user?.id) {
        const payload = change
          ? JSON.stringify(change.kind === 'delete'
            ? {kind:'delete',awardId:award.id}
            : {
              kind:'edit',
              awardId:award.id,
              selectedRows:[...change.selectedRows].sort((a,b)=>a-b),
              ...(change.removalReasons !== undefined ? {removalReasons:sortRemovalReasons(change.removalReasons)} : {}),
            })
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

  const currentWeekKillCount = awards.filter((award) => award.status === 'applied' && award.canModify === true).length;
  const distinctAttendeeCount = new Set(awards
    .filter((award) => award.status === 'applied')
    .flatMap((award) => award.participants.map(participantKey))).size;

  return (
    <section className="space-y-5 text-slate-100">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="page-kicker">Raid archive</p><h1 className="page-title">Boss history</h1><p className="page-description">{canManage ? 'Kill records, attendance, and manager notes.' : 'Boss kills and attendance.'}</p></div>
        <div className="flex flex-wrap gap-1.5 pb-0.5">
          <div title="Kill records currently loaded" className="flex h-9 items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/65 px-2.5"><History size={13} className="text-violet-300" /><span className="text-xs font-bold tabular-nums text-white">{awards.length}</span><span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">loaded</span></div>
          <div className="flex h-9 items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/65 px-2.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /><span className="text-xs font-bold tabular-nums text-white">{currentWeekKillCount}</span><span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">this week</span></div>
          <div title="Distinct toons in loaded kill records" className="flex h-9 items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/65 px-2.5"><Users size={13} className="text-cyan-300" /><span className="text-xs font-bold tabular-nums text-white">{distinctAttendeeCount}</span><span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">seen</span></div>
        </div>
      </div>
      <div className="space-y-3">
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
          const editRows = selectedRows[award.id] ?? [];
          const removedParticipants = isEditing ? getRemovedParticipants(award, editRows, roster) : [];
          const missingRemovalReason = removedParticipants.some((participant) => !removalReasons[award.id]?.[participantKey(participant)]);
          const auditTrail = award.auditTrail ?? [];
          const commentGroups = groupAuditComments(auditTrail);
          return (
            <article key={award.id} className="surface relative overflow-hidden p-0">
              <div className={`h-0.5 bg-gradient-to-r ${BOSS_ACCENTS[award.bossName] ?? 'from-slate-400 via-indigo-400 to-slate-700'}`} />
              <div className="flex flex-col justify-between gap-3 border-b border-slate-800/80 bg-slate-900/45 px-4 py-3 sm:flex-row sm:items-center sm:px-4">
                <div className="flex min-w-0 items-center gap-2.5">
                  <BossIcon bossName={award.bossName} className="h-10 w-10 shrink-0" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h2 className="text-sm font-bold tracking-tight text-white">{award.bossName}</h2>
                      <span className="rounded-md bg-emerald-300/[.08] px-1.5 py-0.5 text-[10px] font-bold text-emerald-200">+{award.points}</span>
                      <span className={`rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[.1em] ${award.status === 'applied' ? award.canModify ? 'border-emerald-300/15 bg-emerald-300/[.06] text-emerald-200' : 'border-slate-500/20 bg-slate-400/[.05] text-slate-300' : 'border-amber-300/15 bg-amber-300/[.06] text-amber-200'}`}>{award.status === 'applied' ? award.canModify ? 'Current' : 'Archive' : award.status}</span>
                    </div>
                    <p className="mt-1 truncate text-[10px] text-slate-500">{new Date(award.createdAt).toLocaleString()} <span className="text-slate-700">·</span> {award.createdBy}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                  {canManage && award.status === 'applied' && !isEditing && award.canModify === true && <>
                    <button
                      onClick={() => { setRemovalReasons((current) => ({...current,[award.id]:{}})); setEditingId(award.id); }}
                      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-indigo-300/20 bg-indigo-300/[.06] px-2.5 text-[11px] font-semibold text-indigo-100 transition hover:border-indigo-200/35 hover:bg-indigo-300/[.12]"
                    ><Users size={13} /> Edit</button>
                    <button
                      onClick={() => void deleteAward(award)}
                      disabled={busyId === award.id}
                      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-rose-300/15 px-2.5 text-[11px] font-semibold text-rose-200 transition hover:border-rose-300/30 hover:bg-rose-300/[.07] disabled:opacity-50"
                    >{busyId === award.id ? <LoaderCircle size={13} className="animate-spin" /> : <Trash2 size={13} />}Delete</button>
                  </>}
                  {commentGroups.length > 0 && <button
                    type="button"
                    aria-expanded={commentsOpenId === award.id}
                    onClick={() => setCommentsOpenId((current) => current === award.id ? '' : award.id)}
                    className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-semibold transition ${commentsOpenId === award.id ? 'border-cyan-200/30 bg-cyan-200/[.1] text-cyan-100' : 'border-slate-700 bg-slate-950/40 text-slate-300 hover:border-cyan-200/25 hover:text-cyan-100'}`}
                  ><MessageCircle size={13} /> Comments <span className="rounded-full bg-white/[.08] px-1.5 py-0.5 text-[9px] tabular-nums">{commentGroups.length}</span></button>}
                </div>
              </div>
              <div className="p-3.5 sm:p-4">

              {canManage && ((award.status === 'updating' && award.pendingChange) || (award.status === 'pending' && award.requestId && (award.createdBy === user?.nickname || ['chief','general'].includes(user?.role ?? '')))) && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[.04] px-3 py-2"><p className="text-[11px] text-amber-200">Finish the pending operation to edit this record.</p><button type="button" disabled={Boolean(busyId)} onClick={() => void resumeAward(award)} className="secondary-button px-2.5 py-1.5 text-[11px]">{busyId === award.id ? <LoaderCircle size={13} className="animate-spin" /> : <History size={13} />}Resume</button></div>}
              {award.status !== 'applied' && award.failureReason && (
                <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{award.failureReason}</p>
              )}

              {canManage && isEditing ? (
                <div className="mt-3">
                  <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-slate-400">
                    <span>Select attendees</span>
                    <span>{selectedCount} selected</span>
                  </div>
                  <div className="boss-history-roster-scroll grid max-h-60 grid-cols-1 gap-1.5 overflow-y-auto rounded-lg border border-slate-800 p-1.5 sm:grid-cols-2">
                    {roster.map((record) => {
                      const isSelected = (selectedRows[award.id] ?? []).includes(record.rowIndex);
                      return (
                        <label
                          key={record.rowIndex}
                          className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-xs transition ${
                            isSelected
                              ? 'border-indigo-400/40 bg-indigo-500/10 text-white shadow-sm shadow-indigo-950/30'
                              : 'border-slate-800/80 bg-slate-950/40 text-slate-300 hover:border-slate-700 hover:bg-slate-800/60'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleRow(award.id, record.rowIndex)}
                            className="h-4 w-4 shrink-0 cursor-pointer accent-indigo-400 focus-visible:outline-indigo-200"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold">{record.account || 'Unnamed toon'}</span>
                            <span className="mt-0.5 block truncate text-[10px] text-slate-500">{record.owner}</span>
                          </span>
                          <RoleBadge role={record.subClass} gameClass compact />
                        </label>
                      );
                    })}
                    {roster.length === 0 && <p className="px-2 py-3 text-sm text-slate-500">No roster records found.</p>}
                  </div>
                  {removedParticipants.length > 0 && (
                    <section className="mt-4 overflow-hidden rounded-2xl border border-rose-300/15 bg-gradient-to-br from-rose-500/[.08] via-slate-950/50 to-amber-400/[.04]">
                      <div className="flex items-center gap-2 border-b border-rose-200/10 px-3 py-2.5">
                        <span className="rounded-md border border-rose-300/15 bg-rose-300/10 p-1 text-rose-200"><UserMinus size={12} /></span>
                        <div><p className="text-xs font-semibold text-rose-100">Removal reason</p><p className="text-[10px] text-slate-500">Required for each removed toon</p></div>
                      </div>
                      <div className="space-y-1.5 p-2">
                        {removedParticipants.map((participant) => {
                          const key = participantKey(participant);
                          return <label key={key} className="grid gap-1.5 rounded-lg border border-white/[.06] bg-slate-950/40 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,.8fr)] sm:items-center">
                            <span className="min-w-0"><span className="block truncate text-xs font-semibold text-slate-100">{participant.account || 'Unnamed toon'}</span><span className="mt-0.5 block truncate text-[10px] text-slate-500">{participant.owner}</span></span>
                            <select
                              aria-label={`Reason for removing ${participant.account || participant.owner}`}
                              value={removalReasons[award.id]?.[key] ?? ''}
                              onChange={(event) => setRemovalReasons((current) => ({...current,[award.id]:{...current[award.id],[key]:event.target.value as BossAttendanceRemovalReason | ''}}))}
                              className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-2 text-[11px] text-slate-200 outline-none transition focus:border-rose-300/60 focus:ring-2 focus:ring-rose-300/10"
                            >
                              <option value="">Select a reason…</option>
                              {BOSS_ATTENDANCE_REMOVAL_REASONS.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
                            </select>
                          </label>;
                        })}
                      </div>
                    </section>
                  )}
                  <div className="mt-2 flex justify-end gap-1.5">
                    <button
                      onClick={() => {
                        setSelectedRows((current) => ({
                          ...current,
                          [award.id]: award.selectedRows,
                        }));
                        setRemovalReasons((current) => ({...current,[award.id]:{}}));
                        setEditingId('');
                      }}
                      disabled={busyId === award.id}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 text-[11px] font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      <X className="h-4 w-4" /> Cancel
                    </button>
                    <button
                      onClick={() => void saveAttendance(award.id)}
                      disabled={busyId === award.id || missingRemovalReason}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {busyId === award.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      {busyId === award.id ? 'Saving changes…' : missingRemovalReason ? 'Choose removal reasons' : 'Save changes'}
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="text-[9px] font-bold uppercase tracking-[.14em] text-slate-500">Attendees</p>
                    <span className="rounded-md bg-slate-900/70 px-2 py-0.5 text-[9px] font-semibold tabular-nums text-slate-500">{award.participants.length}</span>
                  </div>
                  {award.participants.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-slate-800 px-3 py-3 text-center text-[11px] text-slate-500">No attendees</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {award.participants.map((participant) => <span key={`${participant.rowIndex}:${participant.owner}:${participant.account}`} title={`${participant.subClass || 'Unknown subrole'} · ${participant.owner}`} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-white/[.06] bg-slate-900/65 px-2 py-1 text-[11px] text-slate-200"><RoleBadge role={participant.subClass} gameClass compact /><span className="max-w-36 truncate font-medium sm:max-w-48">{participant.account || participant.owner}</span></span>)}
                    </div>
                  )}
                </div>
              )}

              {commentsOpenId === award.id && commentGroups.length > 0 && <section className="mt-3 overflow-hidden rounded-xl border border-cyan-200/10 bg-slate-950/45">
                <div className="flex items-center justify-between gap-3 border-b border-cyan-100/[.08] px-3 py-2.5">
                  <div className="flex items-center gap-2"><span className="rounded-md border border-cyan-100/15 bg-cyan-100/[.06] p-1 text-cyan-100"><MessageCircle size={12} /></span><div><h3 className="text-[11px] font-bold text-cyan-50">Kill comments</h3><p className="text-[9px] text-slate-500">{commentGroups.length} {commentGroups.length === 1 ? 'update' : 'updates'}</p></div></div>
                  <button type="button" onClick={() => setCommentsOpenId('')} className="rounded-md border border-slate-700/80 px-2 py-1 text-[9px] font-semibold text-slate-400 transition hover:border-slate-500 hover:text-white">Close</button>
                </div>
                <div className="space-y-2 p-2.5">
                  {commentGroups.map((comment) => <article key={comment.id} className="rounded-lg border border-white/[.06] bg-slate-950/50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-slate-100">{comment.actor} <span className="font-normal text-slate-400">updated the roster</span></p>
                      <time className="text-[10px] text-slate-500">{new Date(comment.occurredAt).toLocaleString()}</time>
                    </div>
                    {comment.deleted && <p className="mt-3 rounded-lg bg-rose-300/[.07] px-3 py-2 text-xs text-rose-100">The kill record was deleted.</p>}
                    {comment.added.length > 0 && <div className="mt-3 flex flex-wrap items-start gap-2"><span className="inline-flex items-center gap-1.5 pt-1 text-[10px] font-bold uppercase tracking-wider text-emerald-200"><UserPlus size={12} /> Added</span><div className="flex flex-wrap gap-1.5">{comment.added.map((participant) => <span key={`${participant.rowIndex}:${participant.owner}:${participant.account}`} className="inline-flex items-center gap-2 rounded-lg border border-emerald-200/15 bg-emerald-200/[.06] px-2.5 py-1.5 text-[11px] font-medium text-emerald-50"><RoleBadge role={participant.subClass} gameClass compact />{participant.account || participant.owner}</span>)}</div></div>}
                    {comment.removed.length > 0 && <div className="mt-3 flex flex-wrap items-start gap-2"><span className="inline-flex items-center gap-1.5 pt-1 text-[10px] font-bold uppercase tracking-wider text-rose-200"><UserMinus size={12} /> Removed</span><div className="flex flex-col gap-1.5">{comment.removed.map((entry, index) => <div key={`${comment.id}:removed:${index}`} className="flex flex-wrap items-center gap-1.5"><span className="inline-flex items-center gap-2 rounded-lg border border-rose-200/15 bg-rose-200/[.06] px-2.5 py-1.5 text-[11px] font-medium text-rose-50"><RoleBadge role={entry.participant?.subClass} gameClass compact />{entry.participant?.account || entry.participant?.owner || 'Toon'}</span><span className="text-[10px] text-slate-400">Reason: {entry.reason || 'not recorded'}</span></div>)}</div></div>}
                  </article>)}
                </div>
              </section>}
              </div>
            </article>
          );
        })}
        {nextCursor && <button type="button" className="secondary-button mx-auto min-h-8 w-auto px-3 py-1.5 text-[11px]" disabled={loadingMore || refreshing} onClick={() => void loadMoreHistory()}>{loadingMore ? <LoaderCircle size={13} className="animate-spin" /> : <History size={13} />}Load older kills</button>}
      </div>
    </section>
  );
}
