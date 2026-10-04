// app/dashboard/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Plus, CheckCircle2, Shield, Coins, LogOut, Award, Users, Zap, UserCheck } from 'lucide-react';

interface RosterMember {
  rowIndex: number;
  owner: string;
  account: string;
  subClass: string;
  available: number;
}

interface UserSession {
  nickname: string;
  role: string;
  sheetRecordName?: string;
}

const BOSSES = [
  { name: 'Base', points: 1, tier: 'Tier 1' },
  { name: 'Prime', points: 2, tier: 'Tier 2' },
  { name: 'Bt', points: 5, tier: 'Tier 3' },
  { name: 'Gele', points: 6, tier: 'Tier 4' },
  { name: 'Dino', points: 7, tier: 'Tier 5' },
  { name: 'Crom', points: 12, tier: 'Tier 6' },
];

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState<'dkp' | 'auction'>('dkp');
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [userSession, setUserSession] = useState<UserSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBoss, setSelectedBoss] = useState('Base');
  const [selectedMembers, setSelectedMembers] = useState<number[]>([]);
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
      fetchData();
    } catch (err: any) {
      alert(err.message || 'Error submitting DKP');
    } finally {
      setSubmitting(false);
    }
  };

  // Find the currently logged-in user's specific record from the spreadsheet roster
  const currentUserRecord = roster.find(
    (m) => m.owner.toLowerCase() === userSession?.sheetRecordName?.toLowerCase()
  );

  const filteredRoster = roster.filter(
    (m) =>
      m.owner.toLowerCase().includes(searchQuery.toLowerCase()) ||
      m.account.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalDkpDistributedPool = roster.reduce((acc, curr) => acc + curr.available, 0);

  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100 flex flex-col">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md px-6 py-4 flex justify-between items-center sticky top-0 z-30">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center">
            <Shield className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="font-bold tracking-tight text-white text-base">Centuri Clan</h1>
            <p className="text-xs text-slate-400">
              Welcome, <span className="text-indigo-400 font-semibold">{userSession?.nickname}</span>
              {userSession?.role === 'chief' && ' (Chief)'}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {(userSession?.role === 'chief' || userSession?.role === 'general') && (
            <button
              onClick={() => router.push('/admin/requests')}
              className="flex items-center space-x-2 text-xs font-semibold bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 px-3.5 py-2 rounded-xl border border-indigo-500/40 transition-all"
            >
              <UserCheck className="w-3.5 h-3.5" />
              <span>Review Requests</span>
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
      <div className="bg-slate-900/30 border-b border-slate-800/60 px-6 py-4 grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-6xl w-full mx-auto mt-4 rounded-2xl">
        <div className="flex items-center space-x-3 bg-slate-900/60 border border-slate-800 p-3.5 rounded-xl">
          <div className="p-2.5 rounded-lg bg-indigo-500/10 text-indigo-400">
            <Award className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs text-slate-400 uppercase font-medium">Your Sheet DKP</p>
            <p className="text-lg font-bold text-white">
              {currentUserRecord ? `${currentUserRecord.available} pts` : 'Not Linked Yet'}
            </p>
            <p className="text-[10px] text-slate-500">{currentUserRecord ? `Linked to: ${currentUserRecord.owner}` : 'Contact Chief to map account'}</p>
          </div>
        </div>

        <div className="flex items-center space-x-3 bg-slate-900/60 border border-slate-800 p-3.5 rounded-xl">
          <div className="p-2.5 rounded-lg bg-amber-500/10 text-amber-400">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs text-slate-400 uppercase font-medium">Total Clan DKP Pool</p>
            <p className="text-lg font-bold text-white">{totalDkpDistributedPool.toLocaleString()} pts</p>
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
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Left Column: Boss & Submit Form (Only shown to Chief or kept accessible) */}
            {(userSession?.role === 'chief' || userSession?.role === 'general' || userSession?.role === 'guardian') && <div className="bg-slate-900/80 backdrop-blur-xl border border-slate-800/80 p-6 rounded-2xl h-fit space-y-6 shadow-xl">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-indigo-500" />
                Log Boss Kill
              </h2>

              <form onSubmit={handleDkpSubmit} className="space-y-5">
                <div>
                  <label className="block text-xs uppercase tracking-wider text-slate-400 font-semibold mb-2">
                    Select Boss Killed
                  </label>
                  <select
                    value={selectedBoss}
                    onChange={(e) => setSelectedBoss(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
                  >
                    {BOSSES.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name} — {b.points} DKP ({b.tier})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800/80 flex items-center justify-between">
                  <div>
                    <span className="text-xs text-slate-400 font-medium block">Selected Raiders</span>
                    <span className="text-2xl font-black text-indigo-400">{selectedMembers.length}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-slate-400 font-medium block">Points Per Member</span>
                    <span className="text-2xl font-black text-emerald-400">
                      +{BOSSES.find((b) => b.name === selectedBoss)?.points || 0}
                    </span>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 disabled:opacity-50 text-white font-semibold py-3 rounded-xl transition-all shadow-lg shadow-indigo-600/20 flex items-center justify-center space-x-2"
                >
                  <Plus className="w-4 h-4" />
                  <span>{submitting ? 'Updating Sheets...' : 'Submit & Distribute DKP'}</span>
                </button>

                {statusMessage && (
                  <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 p-3.5 rounded-xl text-xs flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>{statusMessage}</span>
                  </div>
                )}
              </form>
            </div>}

            {/* Right Column: Searchable Roster Selector */}
            <div className={`${userSession?.role === 'chief' || userSession?.role === 'general' || userSession?.role === 'guardian' ? 'lg:col-span-2' : 'lg:col-span-3'} bg-slate-900/80 backdrop-blur-xl border border-slate-800/80 p-6 rounded-2xl space-y-5 shadow-xl`}>
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                  <h2 className="text-base font-bold text-white">Clan Roster Selection</h2>
                  <p className="text-xs text-slate-400 mt-0.5">Click members who participated in the kill</p>
                </div>
                <div className="relative w-full sm:w-72">
                  <Search className="absolute left-3.5 top-3 w-4 h-4 text-slate-500" />
                  <input
                    type="text"
                    placeholder="Search member name..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {loading ? (
                <div className="text-center py-16 text-slate-500 text-sm animate-pulse">
                  Syncing roster from Google Sheets...
                </div>
              ) : (
                <div className="border border-slate-800 rounded-xl overflow-hidden max-h-[500px] overflow-y-auto custom-scrollbar">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-950 text-slate-400 text-xs uppercase tracking-wider sticky top-0 z-10 border-b border-slate-800">
                      <tr>
                        <th className="p-3.5 pl-4">Select</th>
                        <th className="p-3.5">Owner / Nickname</th>
                        <th className="p-3.5">Account</th>
                        <th className="p-3.5">Sub Class</th>
                        <th className="p-3.5 pr-4 text-right">Available DKP</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 text-sm">
                      {filteredRoster.map((member) => {
                        const isSelected = selectedMembers.includes(member.rowIndex);
                        const isMe = member.owner.toLowerCase() === userSession?.sheetRecordName?.toLowerCase();
                        return (
                          <tr
                            key={member.rowIndex}
                            onClick={() => toggleMemberSelection(member.rowIndex)}
                            className={`cursor-pointer transition-colors ${
                              isSelected
                                ? 'bg-indigo-950/40 hover:bg-indigo-950/60'
                                : isMe
                                ? 'bg-indigo-900/10 hover:bg-indigo-900/20'
                                : 'hover:bg-slate-800/30'
                            }`}
                          >
                            <td className="p-3.5 pl-4">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => {}}
                                className="w-4 h-4 rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                              />
                            </td>
                            <td className="p-3.5 font-medium text-slate-200 flex items-center gap-2">
                              {member.owner}
                              {isMe && <span className="bg-indigo-500/20 text-indigo-300 text-[10px] px-2 py-0.5 rounded-full border border-indigo-500/30">You</span>}
                            </td>
                            <td className="p-3.5 text-slate-400 text-xs">{member.account}</td>
                            <td className="p-3.5 text-slate-400 text-xs">{member.subClass || '—'}</td>
                            <td className="p-3.5 pr-4 text-right font-bold text-indigo-400">
                              {member.available}
                            </td>
                          </tr>
                        );
                      })}
                      {filteredRoster.length === 0 && (
                        <tr>
                          <td colSpan={5} className="p-8 text-center text-slate-500 text-sm">
                            No matching clan members found.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
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
    </div>
  );
}