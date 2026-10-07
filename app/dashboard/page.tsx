// app/dashboard/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Plus, CheckCircle2, Shield, LogOut, Users, Zap, UserCheck, X, Package } from 'lucide-react';
import BossHistoryPanel from '@/components/BossHistoryPanel';
import AuctionHousePanel from '@/components/AuctionHousePanel';
import AuctionItemsPanel from '@/components/AuctionItemsPanel';

interface RosterMember {
  rowIndex: number;
  owner: string;
  account: string;
  subClass: string;
  weeklyEarned: number;
  weeklySpent: number;
  earned: number;
  spent: number;
  available: number;
}

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

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState<'dkp' | 'auction' | 'boss-history' | 'items'>('dkp');
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
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const router = useRouter();

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const res = await fetch('/api/dkp');
      if (res.status === 401) {
        router.push('/login');
        return;
      }
      const data = await res.json();
      if (data.success) {
        setRoster(data.roster);
        setClanMembers(data.clanMembers);
        setUserSession(data.user);
        setRosterSync(data.rosterSync);
        setRosterSyncError('');
      }
    } catch (err) {
      console.error('Failed to load dashboard data', err);
      setRosterSyncError(err instanceof Error ? err.message : 'Unable to load Google Sheets data');
    } finally {
      setLoading(false);
    }
  };

  const toggleMemberSelection = (rowIndex: number) => {
    setSelectedMembers((prev) =>
      prev.includes(rowIndex) ? prev.filter((id) => id !== rowIndex) : [...prev, rowIndex]
    );
  };

  const handleDkpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedMembers.length === 0) {
      alert('Please select at least one member.');
      return;
    }

    setSubmitting(true);
    setStatusMessage('');

    try {
      const res = await fetch('/api/dkp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bossName: selectedBoss,
          selectedRows: selectedMembers,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setStatusMessage(data.message);
      setSelectedMembers([]);
      setPickerOpen(false);
      setPickerQuery('');
      await fetchData();
    } catch (err: any) {
      alert(err.message || 'Error submitting DKP');
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
      second.available - first.available ||
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
        .includes(memberQuery.toLowerCase())
    );

  const filteredRoster = roster.filter((member) =>
    `${member.owner} ${member.account} ${member.subClass}`
      .toLowerCase()
      .includes(pickerQuery.toLowerCase())
  );
  const canSubmitDkp = ['chief', 'general', 'guardian'].includes(userSession?.role ?? '');

  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100 flex flex-col">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md px-4 sm:px-6 py-4 flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center sticky top-0 z-30">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center">
            <Shield className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="font-bold tracking-tight text-white text-base">Centuri Clan</h1>
            <p className="text-xs text-slate-400">
              Welcome, <span className="text-indigo-400 font-semibold">{userSession?.nickname}</span>
              {userSession?.role && <span className="capitalize"> ({userSession.role})</span>}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            onClick={() => router.push('/admin/requests')}
            className="flex items-center space-x-2 text-xs font-semibold bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 px-3.5 py-2 rounded-xl border border-indigo-500/40 transition-all"
          >
            <UserCheck className="w-3.5 h-3.5" />
            <span>Member Requests</span>
          </button>

          {['chief', 'general', 'guardian'].includes(userSession?.role ?? '') && (
            <button
              onClick={() => setActiveTab('items')}
              className={`flex items-center space-x-2 rounded-xl border px-3.5 py-2 text-xs font-semibold transition-all ${
                activeTab === 'items'
                  ? 'border-emerald-500/40 bg-emerald-600/20 text-emerald-300'
                  : 'border-emerald-500/30 bg-emerald-600/10 text-emerald-300 hover:bg-emerald-600/20'
              }`}
            >
              <Package className="h-3.5 w-3.5" />
              <span>Items</span>
            </button>
          )}

          <button
            onClick={() => {
              document.cookie = 'token=; Max-Age=0; path=/;';
              router.push('/login');
            }}
            className="flex items-center space-x-2 text-xs font-semibold bg-slate-800/80 hover:bg-slate-800 text-slate-300 hover:text-white px-3.5 py-2 rounded-xl border border-slate-700/50 transition-all"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </header>

      {/* Sub-header / Stats Bar */}
      <div className="bg-slate-900/30 border-b border-slate-800/60 px-6 py-4 grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-6xl w-full mx-auto mt-4 rounded-2xl">
        <div className="flex items-center space-x-3 bg-slate-900/60 border border-slate-800 p-3.5 rounded-xl">
          <div className="p-2.5 rounded-lg bg-amber-500/10 text-amber-400">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs text-slate-400 uppercase font-medium">Active clan accounts</p>
            <p className="text-lg font-bold text-white">{clanMembers.length}</p>
            <p className="text-[10px] text-slate-500">Approved members and their linked toons</p>
          </div>
        </div>

        <div className="flex items-center space-x-3 bg-slate-900/60 border border-slate-800 p-3.5 rounded-xl">
          <div className="p-2.5 rounded-lg bg-emerald-500/10 text-emerald-400">
            <Zap className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs text-slate-400 uppercase font-medium">Sync Status</p>
            <p className={`mt-0.5 flex items-center gap-1.5 text-sm font-semibold ${
              rosterSyncError
                ? 'text-rose-300'
                : rosterSync?.stale ? 'text-amber-300' : 'text-emerald-400'
            }`}>
              <span className={`h-2 w-2 rounded-full ${
                rosterSyncError
                  ? 'bg-rose-300'
                  : rosterSync?.stale ? 'bg-amber-300' : 'animate-pulse bg-emerald-400'
              }`} />
              {rosterSyncError
                ? 'Google Sheets unavailable'
                : rosterSync ? rosterSync.stale ? 'Cached roster' : 'Google Sheets synced' : 'Checking roster...'}
            </p>
            {rosterSyncError && (
              <p className="mt-1 break-words text-[10px] text-rose-300">{rosterSyncError}</p>
            )}
            {rosterSync && (
              <p className="mt-1 text-[10px] text-slate-500">
                {rosterSync.refreshDelayed ? 'Refresh delayed; using cached data · ' : 'Last updated · '}
                {new Date(rosterSync.fetchedAt).toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>
      </div>

      <nav aria-label="Dashboard sections" className="mx-auto mt-5 w-full max-w-6xl px-4 sm:px-6">
        <div role="tablist" className="flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60 p-1">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'dkp'}
          onClick={() => setActiveTab('dkp')}
          className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold transition-colors sm:px-4 ${
            activeTab === 'dkp'
              ? 'bg-indigo-500/15 text-indigo-300 shadow-sm'
              : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
          }`}
        >
          DKP History
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'auction'}
          onClick={() => setActiveTab('auction')}
          className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold transition-colors sm:px-4 ${
            activeTab === 'auction'
              ? 'bg-indigo-500/15 text-indigo-300 shadow-sm'
              : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
          }`}
        >
          Auction House
        </button>
        {['chief', 'general', 'guardian', 'clansman'].includes(userSession?.role ?? '') && (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'boss-history'}
            onClick={() => setActiveTab('boss-history')}
            className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold transition-colors sm:px-4 ${
              activeTab === 'boss-history'
                ? 'bg-indigo-500/15 text-indigo-300 shadow-sm'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            Kill Logs
          </button>
        )}
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="flex-1 p-6 max-w-6xl w-full mx-auto">
        {activeTab === 'dkp' ? (
          <div className="space-y-8">
            {canSubmitDkp && (
              <section className="relative overflow-hidden rounded-2xl border border-indigo-400/25 bg-gradient-to-r from-indigo-950 via-slate-900 to-violet-950 px-4 py-4 shadow-xl shadow-indigo-950/25 sm:px-5">
                <div className="pointer-events-none absolute -right-10 -top-20 h-48 w-48 rounded-full bg-indigo-400/15 blur-3xl" />
                <div className="relative flex flex-row items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-indigo-300">Raid operations</p>
                    <h2 className="mt-0.5 text-lg font-black tracking-tight text-white sm:text-xl">Distribute boss DKP</h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setPickerQuery('');
                      setPickerOpen(true);
                    }}
                    className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-3.5 py-2.5 text-xs font-bold text-white shadow-lg shadow-indigo-950/40 transition hover:from-indigo-400 hover:to-violet-400 sm:px-4 sm:text-sm"
                  >
                    <Plus className="h-4 w-4" /> <span className="hidden sm:inline">Submit &amp; distribute</span><span className="sm:hidden">Distribute</span>
                  </button>
                </div>
                {statusMessage && (
                  <div role="status" className="relative mt-5 flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-3 text-sm text-emerald-300">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    {statusMessage}
                  </div>
                )}
              </section>
            )}
            {!canSubmitDkp && (
              <p className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
                Boss DKP distribution is available to Chiefs, Generals, and Guardians.
              </p>
            )}

            <section className="rounded-3xl border border-slate-800 bg-slate-900/50 p-5 shadow-xl sm:p-6">
              <div className="mb-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-300">The roster</p>
                  <h2 className="mt-1 text-xl font-bold text-white">Active toon leaderboard</h2>
                  <p className="mt-1 text-sm text-slate-400">Linked toons grouped by role, then ranked by available DKP.</p>
                </div>
                <label className="relative w-full sm:max-w-sm">
                  <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
                  <input
                    type="search"
                    placeholder="Find a clan member, owner, or toon..."
                    value={memberQuery}
                    onChange={(event) => setMemberQuery(event.target.value)}
                    className="w-full rounded-xl border border-slate-800 bg-slate-950 py-2.5 pl-10 pr-4 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
                  />
                </label>
              </div>

              {loading ? (
                <div className="animate-pulse py-12 text-center text-sm text-slate-500">Syncing active clan roster...</div>
              ) : rankedActiveToons.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-800 py-12 text-center text-sm text-slate-500">
                  No active toons match that search.
                </div>
              ) : (
                <div className="min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/50 shadow-xl shadow-black/10">
                  <table className="w-full table-fixed border-collapse text-left">
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
                                {toon.roleRank}
                              </span>
                            </td>
                            <td className="max-w-0 overflow-hidden px-2 py-2.5 sm:px-3">
                              <span className="block truncate text-sm font-semibold text-white" title={toon.account || toon.owner}>
                                {toon.account || toon.owner}
                              </span>
                            </td>
                            <td className="overflow-hidden px-2 py-2.5 sm:px-3">
                              <span className={`inline-flex max-w-full truncate rounded-full border px-1.5 py-1 text-[9px] font-bold uppercase tracking-wide sm:px-2 sm:text-[10px] ${roleStyle}`}>
                                {toon.subClass || 'Unassigned'}
                              </span>
                            </td>
                            <td className="hidden max-w-36 px-3 py-2.5 text-sm text-slate-300 lg:table-cell">
                              <span className="block truncate" title={toon.owner}>{toon.owner}</span>
                            </td>
                            <td className="hidden px-3 py-2.5 text-right text-sm tabular-nums text-slate-300 lg:table-cell">{toon.earned.toLocaleString()}</td>
                            <td className="hidden px-3 py-2.5 text-right text-sm tabular-nums text-slate-300 lg:table-cell">{toon.spent.toLocaleString()}</td>
                            <td className="overflow-hidden px-2 py-2.5 text-right text-xs font-black tabular-nums text-emerald-300 sm:px-3 sm:text-sm">{toon.available.toLocaleString()}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        ) : activeTab === 'auction' ? (
          <AuctionHousePanel />
        ) : activeTab === 'items' ? (
          <AuctionItemsPanel />
        ) : (
          <BossHistoryPanel embedded />
        )}
      </main>

      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/80 p-0 backdrop-blur-sm sm:items-center sm:p-5"
          onClick={() => !submitting && setPickerOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="award-picker-title"
            className="flex max-h-[95vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl border border-slate-700 bg-[#0b1020] shadow-2xl shadow-black/60 sm:rounded-3xl"
            onClick={(event) => event.stopPropagation()}
          >
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

            <form onSubmit={handleDkpSubmit} className="flex min-h-0 flex-1 flex-col">
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

                <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
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
                  {submitting ? 'Applying award...' : `Distribute to ${selectedMembers.length} toon${selectedMembers.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}