// app/dashboard/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Plus, CheckCircle2, Shield, Coins, LogOut, Award, Users, Zap, UserCheck, X, ArrowDownUp } from 'lucide-react';

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
  const [activeTab, setActiveTab] = useState<'dkp' | 'auction'>('dkp');
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [clanMembers, setClanMembers] = useState<ClanMember[]>([]);
  const [userSession, setUserSession] = useState<UserSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedBoss, setSelectedBoss] = useState('Base');
  const [selectedMembers, setSelectedMembers] = useState<number[]>([]);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');
  const [toonSort, setToonSort] = useState<'owner' | 'role-dkp'>('owner');
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
      }
    } catch (err) {
      console.error('Failed to load dashboard data', err);
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

  const currentUserRecords = roster.filter(
    (member) => userSession?.sheetRecordRows.includes(member.rowIndex)
  );

  const activeToons: ActiveToon[] = clanMembers.flatMap((member) =>
    member.toons.map((toon) => ({ ...toon, memberNickname: member.nickname }))
  );
  const sortedActiveToons = [...activeToons].sort((first, second) => {
    if (toonSort === 'owner') {
      return first.owner.localeCompare(second.owner, undefined, { sensitivity: 'base' }) ||
        (first.account || first.owner).localeCompare(second.account || second.owner, undefined, { sensitivity: 'base' });
    }

    const firstRoleIndex = ROLE_ORDER.indexOf(first.subClass.trim().toLowerCase());
    const secondRoleIndex = ROLE_ORDER.indexOf(second.subClass.trim().toLowerCase());
    const roleDifference = (firstRoleIndex < 0 ? ROLE_ORDER.length : firstRoleIndex) -
      (secondRoleIndex < 0 ? ROLE_ORDER.length : secondRoleIndex);
    return roleDifference ||
      second.available - first.available ||
      first.owner.localeCompare(second.owner, undefined, { sensitivity: 'base' }) ||
      (first.account || first.owner).localeCompare(second.account || second.owner, undefined, { sensitivity: 'base' });
  });
  const rankedActiveToons = sortedActiveToons
    .map((toon, index) => ({ ...toon, rank: index + 1 }))
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

        <div className="flex items-center justify-end space-x-3">
          <button
            onClick={() => router.push('/admin/requests')}
            className="flex items-center space-x-2 text-xs font-semibold bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 px-3.5 py-2 rounded-xl border border-indigo-500/40 transition-all"
          >
            <UserCheck className="w-3.5 h-3.5" />
            <span>Member Requests</span>
          </button>

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
      <div className="bg-slate-900/30 border-b border-slate-800/60 px-6 py-4 grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-6xl w-full mx-auto mt-4 rounded-2xl">
        <div className="flex items-center space-x-3 bg-slate-900/60 border border-slate-800 p-3.5 rounded-xl">
          <div className="p-2.5 rounded-lg bg-indigo-500/10 text-indigo-400">
            <Award className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs text-slate-400 uppercase font-medium">Your linked toons</p>
            <p className="text-lg font-bold text-white">
              {currentUserRecords.length}
            </p>
            <p className="text-[10px] text-slate-500">
              {currentUserRecords.length > 0
                ? 'Each toon’s DKP is shown below'
                : userSession?.role === 'chief' || userSession?.role === 'general'
                  ? 'Link your account in Clan administration'
                  : 'Ask a Chief or General to link your account'}
            </p>
            {currentUserRecords.length === 0 && (userSession?.role === 'chief' || userSession?.role === 'general') && (
              <button onClick={() => router.push('/admin/requests')} className="mt-2 text-xs font-semibold text-indigo-300 hover:text-indigo-200">
                Open clan administration
              </button>
            )}
          </div>
        </div>

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
            <p className="text-sm font-semibold text-emerald-400 flex items-center gap-1.5 mt-0.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Google Sheets Live
            </p>
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex border-b border-slate-800/80 px-6 max-w-6xl w-full mx-auto mt-6">
        <button
          onClick={() => setActiveTab('dkp')}
          className={`py-3 px-6 font-semibold text-sm border-b-2 transition-all flex items-center space-x-2 ${
            activeTab === 'dkp'
              ? 'border-indigo-500 text-indigo-400 bg-indigo-500/5'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <span>DKP Log & Assignment</span>
        </button>
        <button
          onClick={() => setActiveTab('auction')}
          className={`py-3 px-6 font-semibold text-sm border-b-2 transition-all flex items-center space-x-2 ${
            activeTab === 'auction'
              ? 'border-indigo-500 text-indigo-400 bg-indigo-500/5'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <span>Auction House</span>
        </button>
      </div>

      {/* Main Content Area */}
      <main className="flex-1 p-6 max-w-6xl w-full mx-auto">
        {activeTab === 'dkp' ? (
          <div className="space-y-8">
            {canSubmitDkp && (
              <section className="relative overflow-hidden rounded-3xl border border-indigo-400/20 bg-gradient-to-br from-indigo-950 via-slate-900 to-violet-950 p-6 shadow-2xl shadow-indigo-950/30 sm:p-8">
                <div className="pointer-events-none absolute -right-12 -top-24 h-64 w-64 rounded-full bg-indigo-500/10 blur-3xl" />
                <div className="relative flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-300">Raid operations</p>
                    <h2 className="mt-2 text-2xl font-black tracking-tight text-white">Distribute boss DKP</h2>
                    <p className="mt-2 max-w-xl text-sm text-slate-300">Choose a boss, find every participating toon, and record the award.</p>
                  </div>
                  <button
                    onClick={() => {
                      setPickerQuery('');
                      setPickerOpen(true);
                    }}
                    className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-5 py-3 font-bold text-white shadow-lg shadow-indigo-950/40 transition hover:from-indigo-400 hover:to-violet-400"
                  >
                    <Plus className="h-4 w-4" /> Submit &amp; distribute
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

            <section>
              <div className="mb-4 flex items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-indigo-300">Personal DKP</p>
                  <h2 className="mt-1 text-xl font-bold text-white">My toons</h2>
                  <p className="mt-1 text-sm text-slate-400">Each toon has its own earned, spent, and remaining balance.</p>
                </div>
                <Award className="mb-1 h-6 w-6 text-indigo-300" />
              </div>

              {currentUserRecords.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 p-8 text-center">
                  <Users className="mx-auto h-7 w-7 text-slate-500" />
                  <p className="mt-3 font-semibold text-slate-200">No toons linked yet</p>
                  <p className="mt-1 text-sm text-slate-500">Ask a Chief or General to link your sheet rows to your account.</p>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {currentUserRecords.map((toon) => (
                    <article key={toon.rowIndex} className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 shadow-xl shadow-black/10">
                      <div className="flex items-start justify-between gap-3 border-b border-slate-800 p-4">
                        <div className="min-w-0">
                          <h3 className="truncate text-lg font-bold text-white">{toon.account || toon.owner}</h3>
                          <p className="mt-1 truncate text-xs text-slate-400">{toon.owner} · {toon.subClass || 'Class not listed'}</p>
                        </div>
                        <span className="shrink-0 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-xs font-bold text-emerald-300">
                          {toon.available.toLocaleString()} left
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 p-4">
                        {[
                          ['All-time earned', toon.earned],
                          ['All-time spent', toon.spent],
                          ['Available', toon.available],
                        ].map(([label, value]) => (
                          <div key={label} className="rounded-xl bg-slate-950/70 p-3">
                            <p className="text-[10px] font-semibold uppercase leading-tight text-slate-500">{label}</p>
                            <p className="mt-2 text-lg font-black text-slate-100">{Number(value).toLocaleString()}</p>
                          </div>
                        ))}
                      </div>
                      <p className="px-4 pb-4 text-xs text-slate-500">
                        This week: <span className="text-slate-300">{toon.weeklyEarned.toLocaleString()} earned</span>
                        {' · '}
                        <span className="text-slate-300">{toon.weeklySpent.toLocaleString()} spent</span>
                      </p>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-3xl border border-slate-800 bg-slate-900/50 p-5 shadow-xl sm:p-6">
              <div className="mb-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-300">The roster</p>
                  <h2 className="mt-1 text-xl font-bold text-white">Active toon leaderboard</h2>
                  <p className="mt-1 text-sm text-slate-400">Compare linked active toons by owner or by role and available DKP.</p>
                </div>
                <div className="flex w-full flex-col gap-2 sm:max-w-xl sm:flex-row">
                  <label className="relative min-w-0 flex-1">
                    <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
                    <input
                      type="search"
                      placeholder="Find a clan member, owner, or toon..."
                      value={memberQuery}
                      onChange={(event) => setMemberQuery(event.target.value)}
                      className="w-full rounded-xl border border-slate-800 bg-slate-950 py-2.5 pl-10 pr-4 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
                    />
                  </label>
                  <label className="relative shrink-0">
                    <ArrowDownUp className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-500" />
                    <span className="sr-only">Sort toons</span>
                    <select
                      value={toonSort}
                      onChange={(event) => setToonSort(event.target.value as 'owner' | 'role-dkp')}
                      className="w-full appearance-none rounded-xl border border-slate-800 bg-slate-950 py-2.5 pl-9 pr-3 text-sm text-slate-200 outline-none focus:border-indigo-500 sm:w-52"
                    >
                      <option value="owner">Sort by toon owner</option>
                      <option value="role-dkp">Role, then available DKP</option>
                    </select>
                  </label>
                </div>
              </div>

              {loading ? (
                <div className="animate-pulse py-12 text-center text-sm text-slate-500">Syncing active clan roster...</div>
              ) : rankedActiveToons.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-800 py-12 text-center text-sm text-slate-500">
                  No active toons match that search.
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {rankedActiveToons.map((toon) => (
                    <article key={toon.rowIndex} className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/70 p-4 transition hover:-translate-y-0.5 hover:border-indigo-500/30">
                      <div className="flex items-start gap-3">
                        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border text-sm font-black ${
                          toon.rank <= 3 && toonSort === 'role-dkp'
                            ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
                            : 'border-slate-800 bg-slate-900 text-slate-400'
                        }`}>
                          {toon.rank}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate font-bold text-white">{toon.account || toon.owner}</h3>
                            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                              ROLE_STYLES[toon.subClass.trim().toLowerCase()] ?? 'border-slate-700 bg-slate-800 text-slate-300'
                            }`}>
                              {toon.subClass || 'Unassigned'}
                            </span>
                          </div>
                          <p className="mt-1 truncate text-xs text-slate-500">
                            Owner: {toon.owner} · Account: {toon.memberNickname}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Available</p>
                          <p className="text-lg font-black text-emerald-300">{toon.available.toLocaleString()}</p>
                        </div>
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-slate-800 pt-3 text-xs">
                        <p className="text-slate-500">All-time earned <span className="float-right font-semibold text-slate-300">{toon.earned.toLocaleString()}</span></p>
                        <p className="text-right text-slate-500">Spent <span className="font-semibold text-slate-300">{toon.spent.toLocaleString()}</span></p>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>
        ) : (
          /* Auction House Placeholder Tab */
          <div className="bg-slate-900/80 backdrop-blur-xl border border-slate-800/80 p-16 rounded-2xl text-center space-y-4 shadow-xl">
            <div className="w-16 h-16 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center mx-auto text-indigo-400">
              <Coins className="w-8 h-8" />
            </div>
            <h2 className="text-xl font-bold text-white">Auction House Coming Soon</h2>
            <p className="text-slate-400 text-sm max-w-md mx-auto">
              Clan members will soon be able to bid and spend their accumulated DKP points directly on rare boss drops and gear auctions.
            </p>
          </div>
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