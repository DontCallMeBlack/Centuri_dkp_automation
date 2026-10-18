// app/dashboard/page.tsx
'use client';

import { Suspense, useState, useEffect, useRef, useDeferredValue } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import RoleBadge from '@/components/RoleBadge';
import Dialog from '@/components/Dialog';
import LoadingSurface from '@/components/LoadingSurface';
import { useSessionUser } from '@/components/AppShell';
import ToonDkpCards from '@/components/ToonDkpCards';
import RosterDataIssues from '@/components/RosterDataIssues';
import type { ReadableRosterRecord } from '@/lib/sheetRoster';
import { useAutoRefresh } from '@/lib/client/useAutoRefresh';
import { ApiError, clearClientData, getData, peekData, notifyDkpChanged } from '@/lib/client/api';
import { getActionRequestId, completeActionRequest } from '@/lib/client/actionRequests';
import { useRouter } from 'next/navigation';
import { Search, Plus, CheckCircle2, Users, Zap, X, Wallet, Swords } from 'lucide-react';
const BossHistoryPanel = dynamic(() => import('@/components/BossHistoryPanel'), { loading: () => <LoadingSurface /> });
const AuctionHousePanel = dynamic(() => import('@/components/AuctionHousePanel'), { loading: () => <LoadingSurface /> });
const AuctionItemsPanel = dynamic(() => import('@/components/AuctionItemsPanel'), { loading: () => <LoadingSurface /> });

type RosterMember = ReadableRosterRecord;

interface ClanMember {
  nickname: string;
  role: string;
  toons: RosterMember[];
}

interface ActiveToon extends RosterMember {
  memberNickname: string;
}

interface UserSession {
  nickname: string;
  role: string;
  sheetRecordRows: number[];
}

interface RosterSyncStatus {
  fetchedAt: string;
  stale: boolean;
  refreshDelayed: boolean;
}

const BOSSES = [
  { name: 'Base', points: 1, tier: 'Tier 1' },
  { name: 'Prime', points: 2, tier: 'Tier 2' },
  { name: 'Bt', points: 5, tier: 'Tier 3' },
  { name: 'Gele', points: 6, tier: 'Tier 4' },
  { name: 'Dino', points: 7, tier: 'Tier 5' },
  { name: 'Crom', points: 12, tier: 'Tier 6' },
];

const ROLE_ORDER = [
  'ranger',
  'dps rogue',
  'fire mage',
  'ice mage',
  'support druid',
  'dps druid',
  'support rogue',
  'dps warrior',
  'tank',
];

function normalizeRole(role: string) {
  return role.trim().replace(/\s+/g, ' ').toLowerCase();
}

const ROLE_STYLES: Record<string, string> = {
  ranger: 'border-yellow-400/30 bg-yellow-400/10 text-yellow-300',
  'dps rogue': 'border-violet-400/30 bg-violet-400/10 text-violet-300',
  'fire mage': 'border-orange-700/40 bg-orange-800/20 text-orange-400',
  'ice mage': 'border-sky-300/30 bg-sky-300/10 text-sky-200',
  'support druid': 'border-green-400/30 bg-green-400/10 text-green-300',
  'dps druid': 'border-purple-800/50 bg-purple-900/30 text-purple-300',
  'support rogue': 'border-rose-600/40 bg-rose-700/20 text-rose-300',
  'dps warrior': 'border-red-400/30 bg-red-400/10 text-red-300',
  tank: 'border-pink-400/30 bg-pink-400/10 text-pink-300',
};

export default function DashboardPage() { return <Suspense fallback={<LoadingSurface />}><Dashboard /></Suspense>; }

function Dashboard() {
  const searchParams = useSearchParams();
  const sessionUser = useSessionUser();
  const requestedView = searchParams.get('view');
  const activeView = requestedView === 'auction' || requestedView === 'items' || requestedView === 'boss-history' ? requestedView : 'dkp';
  const [visitedViews, setVisitedViews] = useState<Set<string>>(new Set(['dkp']));
  const [refreshing, setRefreshing] = useState(false);
  const [awardError, setAwardError] = useState('');
  const activeRef = useRef(true);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [clanMembers, setClanMembers] = useState<ClanMember[]>([]);
  const [userSession, setUserSession] = useState<UserSession | null>(null);
  const [rosterSync, setRosterSync] = useState<RosterSyncStatus | null>(null);
  const [rosterSyncError, setRosterSyncError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedBoss, setSelectedBoss] = useState('Base');
  const [selectedMembers, setSelectedMembers] = useState<number[]>([]);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');
  const deferredMemberQuery = useDeferredValue(memberQuery);
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const router = useRouter();

  useEffect(() => {
    activeRef.current = true;
    const cached = peekData<any>('/api/dkp');
    if (cached) { setRoster(cached.roster); setClanMembers(cached.clanMembers); setUserSession(cached.user); setRosterSync(cached.rosterSync); setLoading(false); }
    const clear = () => { setRoster([]); setClanMembers([]); setUserSession(null); setRosterSync(null); setSelectedMembers([]); setPickerOpen(false); setMemberQuery(''); setLoading(true); };
    window.addEventListener('centuri:clear-data', clear);
    return () => { activeRef.current = false; window.removeEventListener('centuri:clear-data', clear); };
  }, []);

  useEffect(() => { setVisitedViews((current) => current.has(activeView) ? current : new Set([...current, activeView])); }, [activeView]);


  const fetchData = async () => {
    setRefreshing(true);
    try {
      const data = await getData<{success: boolean; roster: RosterMember[]; clanMembers: ClanMember[]; user: UserSession; rosterSync: RosterSyncStatus}>('/api/dkp');
      if (!data.success) throw new Error('The roster could not be refreshed.');
      if (!activeRef.current) return;
      setRoster(data.roster); setClanMembers(data.clanMembers); setUserSession(data.user); setRosterSync(data.rosterSync); setRosterSyncError('');
    } catch (err) {
      if (!activeRef.current) return;
      if (err instanceof ApiError && err.status === 401) { clearClientData(); router.replace('/login'); }
      else if (activeRef.current) setRosterSyncError(err instanceof Error ? err.message : 'Unable to load clan data');
      return false;
    } finally {
      if (activeRef.current) { setLoading(false); setRefreshing(false); }
    }
  };
  useAutoRefresh(fetchData, { active: activeView === 'dkp' });

  const toggleMemberSelection = (rowIndex: number) => {
    setSelectedMembers((prev) =>
      prev.includes(rowIndex) ? prev.filter((id) => id !== rowIndex) : [...prev, rowIndex]
    );
  };

  const handleDkpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sessionUser?.id) { setAwardError('Your session is still loading. Try again in a moment.'); return; }
    if (selectedMembers.length === 0 || submitting) {
      setAwardError('Please select at least one member.');
      return;
    }

    setSubmitting(true);
    setAwardError('');
    setStatusMessage('');
    const payloadKey = JSON.stringify({ bossName: selectedBoss, selectedRows: [...selectedMembers].sort((a,b) => a-b) });
    try {
      const account = sessionUser.id;
      const requestId = await getActionRequestId(account, 'boss-award', payloadKey);
      const res = await fetch('/api/dkp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          bossName: selectedBoss,
          selectedRows: selectedMembers,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      await completeActionRequest(account, 'boss-award', payloadKey);
      setStatusMessage(data.message);
      notifyDkpChanged();
      setSelectedMembers([]);
      setPickerOpen(false);
      setPickerQuery('');
      await fetchData();
    } catch (err: unknown) {
      setAwardError(err instanceof Error ? err.message : 'The award could not be confirmed. Retry with these same participants.');
    } finally {
      setSubmitting(false);
    }
  };

  const activeToons: ActiveToon[] = clanMembers.flatMap((member) =>
    member.toons.map((toon) => ({ ...toon, memberNickname: member.nickname }))
  );
  const sortedActiveToons = [...activeToons].sort((first, second) => {
    const firstRole = normalizeRole(first.subClass);
    const secondRole = normalizeRole(second.subClass);
    const firstRoleIndex = ROLE_ORDER.indexOf(firstRole);
    const secondRoleIndex = ROLE_ORDER.indexOf(secondRole);
    const firstHasOrderedRole = firstRoleIndex >= 0;
    const secondHasOrderedRole = secondRoleIndex >= 0;
    const roleDifference = firstHasOrderedRole && secondHasOrderedRole
      ? firstRoleIndex - secondRoleIndex
      : firstHasOrderedRole
        ? -1
        : secondHasOrderedRole
          ? 1
          : firstRole.localeCompare(secondRole, undefined, { sensitivity: 'base' });
    return roleDifference ||
      (second.available ?? -Infinity) - (first.available ?? -Infinity) ||
      first.owner.localeCompare(second.owner, undefined, { sensitivity: 'base' }) ||
      (first.account || first.owner).localeCompare(second.account || second.owner, undefined, { sensitivity: 'base' });
  });
  const roleRanks = new Map<string, number>();
  const rankedActiveToons = sortedActiveToons
    .map((toon, index) => {
      const role = normalizeRole(toon.subClass) || 'unassigned';
      const roleRank = (roleRanks.get(role) ?? 0) + 1;
      roleRanks.set(role, roleRank);
      return { ...toon, rank: index + 1, roleRank };
    })
    .filter((toon) =>
      `${toon.memberNickname} ${toon.owner} ${toon.account} ${toon.subClass}`
        .toLowerCase()
        .includes(deferredMemberQuery.toLowerCase())
    );

  const filteredRoster = roster.filter((member) =>
    `${member.owner} ${member.account} ${member.subClass}`
      .toLowerCase()
      .includes(pickerQuery.toLowerCase())
  );
  const canSubmitDkp = ['chief', 'general', 'guardian'].includes(sessionUser?.role ?? userSession?.role ?? '');

  const ownToons = roster.filter((toon) => userSession?.sheetRecordRows.includes(toon.rowIndex));
  const ownAvailable = ownToons.some((toon) => toon.available === null) ? null : ownToons.reduce((sum,toon) => sum+toon.available!,0);

  return (
    <div className="space-y-6">
      {activeView === 'dkp' && <><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div><p className="page-kicker">Your clan. In sync.</p><h1 className="page-title">Welcome back{userSession?.nickname ? `, ${userSession.nickname}` : ''}<span className="text-indigo-400">.</span></h1><p className="page-description">Your raids, rewards, and next upgrade. All in one place.</p></div>
        {canSubmitDkp && <button className="primary-button self-start sm:self-auto" onClick={() => { setAwardError(''); setPickerQuery(''); setPickerOpen(true); }}><Plus className="h-4 w-4" /> Record a kill</button>}
      </div>
      {rosterSyncError && <p role="alert" className="rounded-xl border border-rose-400/20 bg-rose-400/5 px-4 py-3 text-xs text-rose-200">{rosterSyncError} {roster.length > 0 && 'Showing the last known roster. Balances may have changed.'}</p>}
      <RosterDataIssues issues={roster.flatMap((toon) => toon.dkpIssues ?? [])} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[[Users,'Clan members',clanMembers.length,'Approved accounts'],[Swords,'Active toons',activeToons.length,'Linked to your clan'],[Wallet,'My available DKP',ownAvailable,'Before active auction holds']].map(([Icon,label,value,caption]) => {
          const I = Icon as typeof Users;
          return <div key={String(label)} className="surface stat-card last:col-span-2 sm:last:col-span-1"><div className="stat-icon hidden sm:block"><I size={17} strokeWidth={1.7} /></div><div><p className="stat-label">{String(label)}</p>{loading ? <div className="skeleton mt-3 h-6 w-14" /> : <p className="stat-value">{value === null ? '—' : Number(value).toLocaleString()}</p>}<p className="stat-caption">{String(caption)}</p></div></div>;
        })}
      </div><ToonDkpCards toons={ownToons} loading={loading} /></>}
      {/* Main Content Area */}
      <main>
        <section id="panel-dkp" aria-label="Roster" hidden={activeView !== 'dkp'}>
          <div className="space-y-8">
            {canSubmitDkp && statusMessage && <div role="status" className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-3 text-sm text-emerald-300"><CheckCircle2 className="h-4 w-4 shrink-0" />{statusMessage}</div>}
            {!canSubmitDkp && (
              <p className="surface px-4 py-3 text-xs text-slate-400">
                Your DKP and clan activity are shown below. Clan leadership records boss awards.
              </p>
            )}

            <section className="surface overflow-hidden p-5 sm:p-6">
              <div className="mb-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
                <div>
                  <p className="page-kicker">The roster</p>
                  <h2 className="mt-1 text-lg font-semibold text-white">Clan leaderboard</h2>
                  <p className="mt-2 text-xs text-slate-500">Ranked within each class by available DKP.</p>
                </div>
                <label className="relative w-full sm:max-w-sm">
                  <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
                  <input
                    type="search"
                    aria-label="Search clan member, owner, toon, or class"
                    placeholder="Search clan members..."
                    value={memberQuery}
                    onChange={(event) => setMemberQuery(event.target.value)}
                    className="w-full rounded-xl border border-slate-800 bg-slate-950 py-2.5 pl-10 pr-4 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
                  />
                </label>
              </div>

              {loading ? (
                <LoadingSurface rows={6} label="Preparing clan roster" />
              ) : rankedActiveToons.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-800 py-12 text-center text-sm text-slate-500">
                  No active toons match that search.
                </div>
              ) : (
                <div className="min-w-0 overflow-x-auto rounded-xl border border-white/5">
                  <table className="roster-table">
                    <thead className="border-b border-slate-800 bg-slate-900/80 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                      <tr>
                        <th scope="col" className="hidden w-14 px-3 py-3 text-center md:table-cell">Rank</th>
                        <th scope="col" className="w-[48%] px-2 py-3 sm:w-[40%] sm:px-3 lg:w-40">Toon</th>
                        <th scope="col" className="w-[25%] px-2 py-3 sm:w-[22%] sm:px-3 lg:w-36">Role</th>
                        <th scope="col" className="hidden w-32 px-3 py-3 lg:table-cell">Owner</th>
                        <th scope="col" className="hidden w-20 px-3 py-3 text-right lg:table-cell">Earned</th>
                        <th scope="col" className="hidden w-20 px-3 py-3 text-right lg:table-cell">Spent</th>
                        <th scope="col" className="w-[27%] px-2 py-3 text-right sm:w-24 sm:px-3">Available</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/80">
                      {rankedActiveToons.map((toon) => {
                        const roleStyle = ROLE_STYLES[toon.subClass.trim().toLowerCase()]
                          ?? 'border-slate-700 bg-slate-800 text-slate-300';
                        return (
                          <tr key={toon.rowIndex} className="transition hover:bg-slate-800/50">
                            <td className="hidden px-3 py-2.5 text-center md:table-cell">
                              <span className={`inline-flex h-7 min-w-7 items-center justify-center rounded-lg border px-1.5 text-xs font-black ${
                                toon.roleRank === 1
                                  ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
                                  : 'border-slate-700 bg-slate-900 text-slate-400'
                              }`}>
                                {toon.available === null ? '—' : toon.roleRank}
                              </span>
                            </td>
                            <td className="max-w-0 overflow-hidden px-2 py-2.5 sm:px-3">
                              <span className="block truncate text-sm font-semibold text-white" title={toon.account || toon.owner}>
                                {toon.account || toon.owner}
                              </span>
                            </td>
                            <td className="overflow-hidden px-2 py-2.5 sm:px-3">
                              <RoleBadge role={toon.subClass} gameClass />
                            </td>
                            <td className="hidden max-w-36 px-3 py-2.5 text-sm text-slate-300 lg:table-cell">
                              <span className="block truncate" title={toon.owner}>{toon.owner}</span>
                            </td>
                            <td className="hidden px-3 py-2.5 text-right text-sm tabular-nums text-slate-300 lg:table-cell">{toon.earned?.toLocaleString() ?? '—'}</td>
                            <td className="hidden px-3 py-2.5 text-right text-sm tabular-nums text-slate-300 lg:table-cell">{toon.spent?.toLocaleString() ?? '—'}</td>
                            <td className={`overflow-hidden px-2 py-2.5 text-right text-xs font-semibold tabular-nums sm:px-3 sm:text-sm ${toon.available === null ? 'text-amber-200' : toon.available < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{toon.available?.toLocaleString() ?? '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <div role="status" className="flex items-center justify-end gap-2 text-[10px] text-slate-500"><span className={`h-1.5 w-1.5 rounded-full ${refreshing ? 'animate-pulse bg-indigo-400' : rosterSyncError || rosterSync?.stale ? 'bg-amber-300' : rosterSync ? 'bg-emerald-400' : 'bg-slate-600'}`} />{refreshing ? 'Refreshing roster' : rosterSyncError || rosterSync?.stale ? 'Cached roster - refresh needed' : rosterSync ? `Updated ${new Date(rosterSync.fetchedAt).toLocaleTimeString()}` : 'Roster not loaded'}</div>
          </div>
        </section>
        {(activeView === 'auction' || visitedViews.has('auction')) && <section id="panel-auction" aria-label="Auction house" hidden={activeView !== 'auction'}><AuctionHousePanel active={activeView === 'auction'} /></section>}
        {canSubmitDkp && (activeView === 'items' || visitedViews.has('items')) && <section id="panel-items" aria-label="Item catalog" hidden={activeView !== 'items'}><AuctionItemsPanel active={activeView === 'items'} /></section>}
        {(activeView === 'boss-history' || visitedViews.has('boss-history')) && <section id="panel-boss-history" aria-label="Kill history" hidden={activeView !== 'boss-history'}><BossHistoryPanel embedded active={activeView === 'boss-history'} /></section>}
        {activeView === 'items' && (sessionUser || !loading) && !canSubmitDkp && <p role="alert" className="surface p-6 text-sm text-slate-400">Item management requires a Chief, General, or Guardian account.</p>}
      </main>

      {pickerOpen && (
        <Dialog labelledBy="award-picker-title" busy={submitting} onClose={() => setPickerOpen(false)}>
            <div className="relative shrink-0 overflow-hidden border-b border-slate-800 bg-gradient-to-r from-indigo-950 via-slate-900 to-violet-950 p-5 sm:p-6">
              <div className="pointer-events-none absolute -right-8 -top-16 h-48 w-48 rounded-full bg-indigo-400/10 blur-3xl" />
              <div className="relative flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-300">Raid operations</p>
                  <h2 id="award-picker-title" className="mt-1 break-words text-lg font-black leading-tight text-white sm:text-2xl">Choose boss &amp; participants</h2>
                  <p className="mt-2 text-sm leading-snug text-slate-400">Search every toon in the sheet and select everyone who attended.</p>
                </div>
                <button
                  type="button"
                  aria-label="Close participant menu"
                  disabled={submitting}
                  onClick={() => setPickerOpen(false)}
                  className="shrink-0 rounded-lg border border-slate-700 p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <form onSubmit={handleDkpSubmit} className="flex min-h-0 flex-1 flex-col"><fieldset disabled={submitting} className="contents"><legend className="sr-only">Boss and participants</legend>
              {awardError && <p role="alert" className="mx-5 mt-4 rounded-xl border border-rose-400/20 bg-rose-400/5 p-3 text-xs text-rose-200">{awardError}</p>}
              <div className="grid gap-4 border-b border-slate-800 p-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:p-6">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Boss defeated
                  <select
                    value={selectedBoss}
                    onChange={(event) => setSelectedBoss(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-3 text-sm font-semibold normal-case text-white outline-none focus:border-indigo-400"
                  >
                    {BOSSES.map((boss) => (
                      <option key={boss.name} value={boss.name}>
                        {boss.name} · +{boss.points} DKP · {boss.tier}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center justify-between rounded-xl border border-indigo-400/20 bg-indigo-500/10 px-4 py-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-indigo-200">Raid reward</p>
                    <p className="mt-1 text-sm text-slate-300">{selectedBoss} attendance award</p>
                  </div>
                  <p className="text-2xl font-black text-emerald-300">
                    +{BOSSES.find((boss) => boss.name === selectedBoss)?.points ?? 0}
                  </p>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col p-5 sm:p-6">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-white">All sheet toons</h3>
                    <p className="mt-1 text-xs text-slate-500">{selectedMembers.length} selected · select any toon that attended</p>
                  </div>
                  <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-300">
                    {roster.length} toons
                  </span>
                </div>
                <div className="relative mb-3">
                  <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
                  <input
                    autoFocus
                    type="search"
                    aria-label="Search all sheet toons"
                    placeholder="Search owner, toon, or class..."
                    value={pickerQuery}
                    onChange={(event) => setPickerQuery(event.target.value)}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-slate-600 outline-none focus:border-indigo-400"
                  />
                </div>

                {selectedMembers.length > 0 && (
                  <div className="mb-3 flex max-h-20 flex-wrap gap-2 overflow-y-auto">
                    {roster.filter((toon) => selectedMembers.includes(toon.rowIndex)).map((toon) => (
                      <span key={toon.rowIndex} className="rounded-full border border-indigo-400/30 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-200">
                        {toon.account || toon.owner}
                      </span>
                    ))}
                  </div>
                )}

                <div className="grid max-h-[35dvh] min-h-0 flex-1 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                  {filteredRoster.map((toon) => {
                    const selected = selectedMembers.includes(toon.rowIndex);
                    return (
                      <button
                        key={toon.rowIndex}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleMemberSelection(toon.rowIndex)}
                        className={`flex items-center justify-between gap-3 rounded-xl border p-3 text-left transition ${
                          selected
                            ? 'border-indigo-400/60 bg-indigo-500/15 shadow-lg shadow-indigo-950/30'
                            : 'border-slate-800 bg-slate-900/60 hover:border-slate-600 hover:bg-slate-800/80'
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-white">{toon.account || toon.owner}</span>
                          <span className="mt-1 block truncate text-xs text-slate-500">{toon.owner} · {toon.subClass || 'Class not listed'}</span>
                        </span>
                        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${
                          selected ? 'border-indigo-300 bg-indigo-400 text-slate-950' : 'border-slate-700 text-slate-500'
                        }`}>
                          {selected ? '✓' : '+'}
                        </span>
                      </button>
                    );
                  })}
                  {filteredRoster.length === 0 && (
                    <p className="col-span-full py-10 text-center text-sm text-slate-500">No sheet toons match that search.</p>
                  )}
                </div>
              </div>

              <div className="flex flex-col-reverse gap-2 border-t border-slate-800 bg-slate-950/70 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <button
                  type="button"
                  onClick={() => setPickerOpen(false)}
                  disabled={submitting}
                  className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting || selectedMembers.length === 0}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-indigo-950/40 transition hover:from-indigo-400 hover:to-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? <Zap className="h-4 w-4 animate-pulse" /> : <Plus className="h-4 w-4" />}
                  {submitting ? 'Recording kill...' : `Record kill · ${selectedMembers.length} toon${selectedMembers.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </fieldset></form>
        </Dialog>
      )}
    </div>
  );
}
