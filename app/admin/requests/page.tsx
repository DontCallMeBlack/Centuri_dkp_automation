'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, ClipboardList, LoaderCircle, Shield, Trash2, UserCheck, Users, X, Zap } from 'lucide-react';

interface ClanUser {
  _id: string;
  nickname: string;
  role: string;
  sheetRecordName?: string;
}

interface RosterMember {
  rowIndex: number;
  owner: string;
  account: string;
  available?: number;
}

type AdminSection = 'requests' | 'members' | 'boss';

const BOSSES = [
  { name: 'Base', points: 1 },
  { name: 'Prime', points: 2 },
  { name: 'Bt', points: 5 },
  { name: 'Gele', points: 6 },
  { name: 'Dino', points: 7 },
  { name: 'Crom', points: 12 },
];

export default function AdminRequestsPage() {
  const [section, setSection] = useState<AdminSection>('requests');
  const [pendingUsers, setPendingUsers] = useState<ClanUser[]>([]);
  const [members, setMembers] = useState<ClanUser[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [selectedMappings, setSelectedMappings] = useState<Record<string, string>>({});
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [selectedBoss, setSelectedBoss] = useState('Base');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const router = useRouter();

  const loadData = async () => {
    try {
      const res = await fetch('/api/admin/requests');
      if (res.status === 401 || res.status === 403) {
        router.push('/dashboard');
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load clan administration data');
      setPendingUsers(data.pendingUsers);
      setMembers(data.members);
      setRoster(data.roster);
      setSelectedMappings((current) => {
        const next = { ...current };
        for (const member of data.members as ClanUser[]) {
          if (!next[member._id] && member.sheetRecordName) next[member._id] = member.sheetRecordName;
        }
        return next;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load clan administration data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const sendAdminAction = async (userId: string, action: string, sheetRecordName?: string) => {
    setBusyId(userId);
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/admin/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action, sheetRecordName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'The request could not be completed');
      setNotice(data.message);
      await loadData();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'The request could not be completed');
    } finally {
      setBusyId('');
    }
  };

  const approveRequest = (userId: string) => {
    const name = selectedMappings[userId];
    if (!name) {
      setError('Choose a Google Sheets roster name before approving this request.');
      return;
    }
    void sendAdminAction(userId, 'approve', name);
  };

  const denyRequest = (userId: string) => void sendAdminAction(userId, 'deny');
  const linkMember = (userId: string) => {
    const name = selectedMappings[userId];
    if (!name) {
      setError('Choose a Google Sheets roster name before linking this account.');
      return;
    }
    void sendAdminAction(userId, 'link', name);
  };

  const removeMember = (member: ClanUser) => {
    if (window.confirm(`Remove ${member.nickname}'s account from the app? This cannot be undone.`)) {
      void sendAdminAction(member._id, 'remove');
    }
  };

  const toggleRow = (rowIndex: number) => {
    setSelectedRows((current) => current.includes(rowIndex)
      ? current.filter((selected) => selected !== rowIndex)
      : [...current, rowIndex]);
  };

  const recordBoss = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusyId('boss');
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/dkp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bossName: selectedBoss, selectedRows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not record boss award');
      setNotice(data.message);
      setSelectedRows([]);
      await loadData();
    } catch (recordError) {
      setError(recordError instanceof Error ? recordError.message : 'Could not record boss award');
    } finally {
      setBusyId('');
    }
  };

  if (loading) {
    return <div className="min-h-screen bg-[#07090e] p-8 text-sm text-slate-400">Loading clan administration...</div>;
  }

  return (
    <main className="min-h-screen bg-[#07090e] text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-slate-950/90 px-5 py-4 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-bold text-white">Clan administration</h1>
              <p className="text-xs text-slate-400">Requests, member access, and boss awards</p>
            </div>
          </div>
          <button onClick={() => router.push('/dashboard')} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800">
            <ArrowLeft className="h-4 w-4" /> <span className="hidden sm:inline">Dashboard</span>
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-6 sm:px-8">
        <nav aria-label="Administration sections" className="flex overflow-x-auto border-b border-slate-800">
          {([
            ['requests', 'Sign-up requests', UserCheck, pendingUsers.length],
            ['members', 'Members', Users, members.length],
            ['boss', 'Boss award', Zap, undefined],
          ] as const).map(([key, label, Icon, count]) => (
            <button
              key={key}
              onClick={() => setSection(key)}
              className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold ${section === key ? 'border-indigo-400 text-indigo-300' : 'border-transparent text-slate-400 hover:text-white'}`}
            >
              <Icon className="h-4 w-4" /> {label}
              {count !== undefined && <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{count}</span>}
            </button>
          ))}
        </nav>

        {error && <p role="alert" className="mt-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}
        {notice && <p role="status" className="mt-5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>}

        {section === 'requests' && (
          <section className="mt-6 space-y-3">
            <div className="mb-5 flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-white">Pending sign-ups</h2>
                <p className="mt-1 text-sm text-slate-400">Approve a request and link it to a roster record, or deny it.</p>
              </div>
              <ClipboardList className="mb-1 h-5 w-5 text-slate-500" />
            </div>
            {pendingUsers.length === 0 ? (
              <p className="border-y border-slate-800 py-10 text-center text-sm text-slate-500">No pending sign-up requests.</p>
            ) : pendingUsers.map((user) => (
              <article key={user._id} className="grid gap-4 border-b border-slate-800 py-4 md:grid-cols-[1fr_auto] md:items-center">
                <div>
                  <h3 className="font-semibold text-white">{user.nickname}</h3>
                  <p className="mt-1 text-xs text-slate-500">Awaiting approval and roster mapping</p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <select
                    aria-label={`Roster record for ${user.nickname}`}
                    value={selectedMappings[user._id] || ''}
                    onChange={(event) => setSelectedMappings({ ...selectedMappings, [user._id]: event.target.value })}
                    className="min-w-56 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                  >
                    <option value="">Select roster name</option>
                    {roster.map((record) => <option key={record.rowIndex} value={record.owner}>{record.owner} ({record.account})</option>)}
                  </select>
                  <button disabled={busyId === user._id} onClick={() => approveRequest(user._id)} className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
                    {busyId === user._id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Approve
                  </button>
                  <button disabled={busyId === user._id} onClick={() => denyRequest(user._id)} className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-500/40 px-3 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/10 disabled:opacity-50">
                    <X className="h-4 w-4" /> Deny
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}

        {section === 'members' && (
          <section className="mt-6">
            <h2 className="text-lg font-bold text-white">Approved clan accounts</h2>
            <p className="mb-4 mt-1 text-sm text-slate-400">Change a member’s sheet mapping or remove their app account.</p>
            {members.length === 0 ? <p className="border-y border-slate-800 py-10 text-center text-sm text-slate-500">No approved member accounts.</p> : (
              <div className="divide-y divide-slate-800 border-y border-slate-800">
                {members.map((member) => (
                  <article key={member._id} className="grid gap-3 py-4 md:grid-cols-[minmax(10rem,1fr)_minmax(14rem,20rem)_auto] md:items-center">
                    <div>
                      <h3 className="font-semibold text-white">{member.nickname}</h3>
                      <p className="mt-1 text-xs capitalize text-slate-500">{member.role} · {member.sheetRecordName || 'Not linked'}</p>
                    </div>
                    <select
                      aria-label={`Roster record for ${member.nickname}`}
                      value={selectedMappings[member._id] || ''}
                      onChange={(event) => setSelectedMappings({ ...selectedMappings, [member._id]: event.target.value })}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                    >
                      <option value="">Select roster name</option>
                      {roster.map((record) => <option key={record.rowIndex} value={record.owner}>{record.owner} ({record.account})</option>)}
                    </select>
                    <div className="flex gap-2">
                      <button disabled={busyId === member._id} onClick={() => linkMember(member._id)} className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-indigo-500/40 px-3 py-2 text-sm font-semibold text-indigo-200 hover:bg-indigo-500/10 disabled:opacity-50">
                        <UserCheck className="h-4 w-4" /> Link
                      </button>
                      <button disabled={busyId === member._id} onClick={() => removeMember(member)} title={`Remove ${member.nickname}`} className="inline-flex items-center justify-center rounded-lg border border-red-500/40 px-3 py-2 text-red-300 hover:bg-red-500/10 disabled:opacity-50">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {section === 'boss' && (
          <section className="mt-6">
            <h2 className="text-lg font-bold text-white">Record a boss award</h2>
            <p className="mb-5 mt-1 text-sm text-slate-400">Select every participating roster record, including guardians.</p>
            <form onSubmit={recordBoss} className="space-y-5">
              <label className="block max-w-sm text-xs font-semibold uppercase text-slate-400">
                Boss
                <select value={selectedBoss} onChange={(event) => setSelectedBoss(event.target.value)} className="mt-2 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm normal-case text-slate-100">
                  {BOSSES.map((boss) => <option key={boss.name} value={boss.name}>{boss.name} · {boss.points} DKP</option>)}
                </select>
              </label>
              <div className="overflow-hidden border-y border-slate-800">
                <div className="flex items-center justify-between py-3 text-xs font-semibold uppercase text-slate-500">
                  <span>Roster participants</span><span>{selectedRows.length} selected</span>
                </div>
                <div className="grid max-h-[28rem] grid-cols-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
                  {roster.map((record) => (
                    <label key={record.rowIndex} className="flex cursor-pointer items-center gap-3 border-t border-slate-800/70 px-3 py-3 text-sm hover:bg-slate-900/60">
                      <input type="checkbox" checked={selectedRows.includes(record.rowIndex)} onChange={() => toggleRow(record.rowIndex)} className="h-4 w-4 accent-indigo-500" />
                      <span className="min-w-0"><span className="block truncate font-medium text-slate-200">{record.owner}</span><span className="block truncate text-xs text-slate-500">{record.account}</span></span>
                    </label>
                  ))}
                </div>
                {roster.length === 0 && <p className="border-t border-slate-800 py-8 text-center text-sm text-slate-500">No roster records found.</p>}
              </div>
              <button type="submit" disabled={busyId === 'boss' || selectedRows.length === 0} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
                {busyId === 'boss' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                Record {selectedBoss} award
              </button>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}