'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, ChevronUp, ClipboardList, LoaderCircle, Search, Shield, Trash2, UserCheck, Users, X } from 'lucide-react';

interface ClanUser {
  _id: string;
  nickname: string;
  role: string;
  sheetRecordRows?: number[];
}

interface RosterMember {
  rowIndex: number;
  owner: string;
  account: string;
  available?: number;
}

type ClanRole = 'chief' | 'general' | 'guardian' | 'clansman';

type AdminSection = 'requests' | 'members';

export default function AdminRequestsPage() {
  const [section, setSection] = useState<AdminSection>('requests');
  const [pendingUsers, setPendingUsers] = useState<ClanUser[]>([]);
  const [members, setMembers] = useState<ClanUser[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [selectedMappings, setSelectedMappings] = useState<Record<string, number[]>>({});
  const [mappingQueries, setMappingQueries] = useState<Record<string, string>>({});
  const [editingToonsFor, setEditingToonsFor] = useState('');
  const [loading, setLoading] = useState(true);
  const [accessRole, setAccessRole] = useState('');
  const [managerRole, setManagerRole] = useState<ClanRole | ''>('');
  const [managerId, setManagerId] = useState('');
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const router = useRouter();

  const loadData = async () => {
    try {
      const res = await fetch('/api/admin/requests');
      const data = await res.json();
      if (res.status === 401) {
        router.push('/login');
        return;
      }
      if (res.status === 403) {
        setAccessRole(data.role || 'member');
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Failed to load clan administration data');
      setManagerRole(data.managerRole ?? '');
      setManagerId(data.managerId ?? '');
      setPendingUsers(data.pendingUsers);
      setMembers(data.members);
      setRoster(data.roster);
      setSelectedMappings(Object.fromEntries(
        [...data.pendingUsers, ...data.members].map((member: ClanUser) => [
          member._id,
          member.sheetRecordRows ?? [],
        ]),
      ));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load clan administration data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const sendAdminAction = async (
    userId: string,
    action: string,
    sheetRecordRows?: number[],
    role?: ClanRole,
  ) => {
    setBusyId(userId);
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/admin/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action, sheetRecordRows, role }),
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
    const rows = selectedMappings[userId] ?? [];
    if (rows.length === 0) {
      setError('Select at least one toon row before approving this request.');
      return;
    }
    void sendAdminAction(userId, 'approve', rows);
  };

  const denyRequest = (userId: string) => void sendAdminAction(userId, 'deny');
  const linkMember = (userId: string) => {
    const rows = selectedMappings[userId] ?? [];
    if (rows.length === 0) {
      setError('Select at least one toon row before linking this account.');
      return;
    }
    void sendAdminAction(userId, 'link', rows);
  };

  const toggleMapping = (userId: string, rowIndex: number) => {
    setSelectedMappings((current) => {
      const rows = current[userId] ?? [];
      return {
        ...current,
        [userId]: rows.includes(rowIndex)
          ? rows.filter((selectedRow) => selectedRow !== rowIndex)
          : [...rows, rowIndex],
      };
    });
  };

  const renderMappingSelector = (userId: string, label: string) => {
    const currentMember = members.find((member) => member._id === userId);
    const occupiedRows = new Set(members.flatMap((member) => member.sheetRecordRows ?? []));
    const availableRoster = roster.filter((record) =>
      !occupiedRows.has(record.rowIndex) ||
      (currentMember?.sheetRecordRows ?? []).includes(record.rowIndex),
    );

    const query = (mappingQueries[userId] ?? '').trim().toLowerCase();
    const filteredRoster = availableRoster.filter((record) =>
      `${record.account} ${record.owner}`.toLowerCase().includes(query),
    );

    return (
      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950/70">
        <label className="relative block border-b border-slate-800">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
          <span className="sr-only">Search {label}</span>
          <input
            type="search"
            value={mappingQueries[userId] ?? ''}
            onChange={(event) => setMappingQueries((current) => ({
              ...current,
              [userId]: event.target.value,
            }))}
            placeholder="Search toons..."
            className="w-full bg-transparent py-2.5 pl-9 pr-3 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:bg-slate-900/70"
          />
        </label>
        <fieldset className="max-h-40 overflow-y-auto p-1.5">
          <legend className="sr-only">{label}</legend>
          {filteredRoster.map((record) => {
            const isSelected = (selectedMappings[userId] ?? []).includes(record.rowIndex);
            return (
              <label
                key={record.rowIndex}
                className={`mb-0.5 flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border px-2 py-1.5 text-sm transition last:mb-0 ${
                  isSelected
                    ? 'border-indigo-400/40 bg-indigo-500/10 text-white'
                    : 'border-transparent text-slate-300 hover:bg-slate-900'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleMapping(userId, record.rowIndex)}
                  className="h-4 w-4 shrink-0 cursor-pointer accent-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium leading-5">
                    {record.account || 'Unnamed toon'} <span className="font-normal text-slate-500">· {record.owner}</span>
                  </span>
                </span>
              </label>
            );
          })}
        {filteredRoster.length === 0 && (
          <p className="px-2 py-3 text-center text-xs text-slate-500">
            {availableRoster.length === 0
              ? roster.length === 0 ? 'No roster records found.' : 'No unlinked toon rows available.'
              : 'No toons match this search.'}
          </p>
        )}
        </fieldset>
      </div>
    );
  };

  const removeMember = (member: ClanUser) => {
    if (window.confirm(`Remove ${member.nickname}'s account from the app? This cannot be undone.`)) {
      void sendAdminAction(member._id, 'remove');
    }
  };

  const unlinkToon = (member: ClanUser, record: RosterMember) => {
    const toonName = record.account || record.owner;
    if (window.confirm(`Unlink ${toonName} from ${member.nickname}? It will become available to link to another account.`)) {
      void sendAdminAction(member._id, 'unlink', [record.rowIndex]);
    }
  };

  const updateRole = (member: ClanUser, role: ClanRole, direction: 'promote' | 'demote') => {
    if (!window.confirm(`${direction === 'promote' ? 'Promote' : 'Demote'} ${member.nickname} from ${member.role} to ${role}?`)) return;
    void sendAdminAction(member._id, 'set-role', undefined, role);
  };

  const getAdjacentRole = (role: string, direction: 'promote' | 'demote'): ClanRole | undefined => {
    const hierarchy: ClanRole[] = ['chief', 'general', 'guardian', 'clansman'];
    const currentIndex = hierarchy.indexOf(role as ClanRole);
    if (currentIndex < 0) return undefined;
    return hierarchy[currentIndex + (direction === 'promote' ? 1 : -1)];
  };

  if (loading) {
    return <div className="min-h-screen bg-[#07090e] p-8 text-sm text-slate-400">Loading clan administration...</div>;
  }

  if (accessRole) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#07090e] px-5 text-slate-100">
        <section className="w-full max-w-md border-y border-slate-800 py-8 text-center">
          <Shield className="mx-auto h-8 w-8 text-amber-300" />
          <h1 className="mt-4 text-lg font-bold text-white">Manager access required</h1>
          <p className="mt-2 text-sm text-slate-400">This page is for Chief and General accounts. Your current role is <span className="capitalize text-slate-200">{accessRole}</span>.</p>
          <button onClick={() => router.push('/dashboard')} className="mt-5 rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Back to dashboard</button>
        </section>
      </main>
    );
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
              <p className="text-xs text-slate-400">Sign-up requests and member access</p>
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
                <p className="mt-1 text-sm text-slate-400">Choose one or more unlinked sheet rows to connect to each new account.</p>
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
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                  <div className="min-w-56 flex-1">
                    {renderMappingSelector(user._id, `Toon rows for ${user.nickname}`)}
                    <p className="mt-1 text-xs text-slate-500">{(selectedMappings[user._id] ?? []).length} toon(s) selected</p>
                  </div>
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
            <h2 className="text-lg font-bold text-white">Approved accounts</h2>
            <p className="mb-4 mt-1 text-sm text-slate-400">Toons linked to another account are hidden. Unlink a toon to make it available for reassignment.</p>
            {members.length === 0 ? <p className="border-y border-slate-800 py-10 text-center text-sm text-slate-500">No approved member accounts.</p> : (
              <div className="divide-y divide-slate-800 border-y border-slate-800">
                {members.map((member) => {
                  const promotedRole = getAdjacentRole(member.role, 'promote');
                  const demotedRole = getAdjacentRole(member.role, 'demote');
                  const canManageRole = member._id !== managerId &&
                    (managerRole === 'chief' ||
                      (managerRole === 'general' && member.role !== 'chief' && member.role !== 'general'));
                  const canPromote = promotedRole !== undefined &&
                    (managerRole === 'chief' || promotedRole === 'guardian');
                  const canDemote = demotedRole !== undefined &&
                    (managerRole === 'chief' || demotedRole === 'clansman') &&
                    !(member.role === 'chief' && members.filter((entry) => entry.role === 'chief').length <= 1);

                  return (
                  <article key={member._id} className="grid min-w-0 gap-3 py-4 md:grid-cols-[minmax(10rem,0.8fr)_minmax(14rem,1.2fr)] md:items-start">
                    <div>
                      <h3 className="font-semibold text-white">{member.nickname}</h3>
                      <p className="mt-1 text-xs capitalize text-slate-500">{member.role} · {(member.sheetRecordRows ?? []).length} toon(s) linked</p>
                    </div>
                    <div className="min-w-0">
                      {(member.sheetRecordRows ?? []).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(member.sheetRecordRows ?? []).flatMap((rowIndex) => {
                            const record = roster.find((entry) => entry.rowIndex === rowIndex);
                            if (!record) return [];
                            return (
                              <span key={rowIndex} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300">
                                <span className="max-w-36 truncate">{record.account || record.owner}</span>
                                <button
                                  type="button"
                                  onClick={() => unlinkToon(member, record)}
                                  disabled={busyId === member._id}
                                  aria-label={`Unlink ${record.account || record.owner} from ${member.nickname}`}
                                  title="Unlink toon"
                                  className="rounded p-0.5 text-slate-500 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      )}
                      <button
                        type="button"
                        aria-expanded={editingToonsFor === member._id}
                        onClick={() => setEditingToonsFor((current) => current === member._id ? '' : member._id)}
                        className="mt-2 inline-flex w-full items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-indigo-500/40 hover:bg-slate-800 sm:w-auto"
                      >
                        <span className="inline-flex items-center gap-2">
                          <Users className="h-4 w-4 text-indigo-300" />
                          Manage linked toons
                        </span>
                        {editingToonsFor === member._id
                          ? <ChevronUp className="h-4 w-4 text-slate-400" />
                          : <ChevronDown className="h-4 w-4 text-slate-400" />}
                      </button>
                      {editingToonsFor === member._id && (
                        <div className="mt-2 space-y-2">
                          {renderMappingSelector(member._id, `Available toon rows for ${member.nickname}`)}
                          <p className="text-xs text-slate-500">{(selectedMappings[member._id] ?? []).length} toon(s) selected</p>
                          <button
                            type="button"
                            disabled={busyId === member._id || (selectedMappings[member._id] ?? []).length === 0}
                            onClick={() => linkMember(member._id)}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-indigo-500/40 px-3 py-2 text-sm font-semibold text-indigo-200 transition hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {busyId === member._id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <UserCheck className="h-4 w-4" />}
                            Save toon links
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="flex min-w-0 flex-col gap-2 md:col-span-2 lg:flex-row lg:items-center">
                      {canManageRole && (
                        <div className="grid w-full grid-cols-2 gap-2 lg:max-w-md">
                          <button
                            type="button"
                            disabled={busyId === member._id || !canPromote}
                            onClick={() => promotedRole && updateRole(member, promotedRole, 'promote')}
                            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/20 via-emerald-600/15 to-green-700/20 px-3 py-2 text-sm font-bold text-emerald-200 shadow-lg shadow-emerald-950/20 transition hover:border-emerald-300/60 hover:from-emerald-400/30 hover:to-green-500/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-35"
                          >
                            {busyId === member._id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                            <span>Promote</span>
                            {promotedRole && <span className="hidden text-xs font-medium text-emerald-100/70 sm:inline">to {promotedRole}</span>}
                          </button>
                          <button
                            type="button"
                            disabled={busyId === member._id || !canDemote}
                            onClick={() => demotedRole && updateRole(member, demotedRole, 'demote')}
                            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-red-400/30 bg-gradient-to-br from-red-500/20 via-rose-600/15 to-red-800/20 px-3 py-2 text-sm font-bold text-red-200 shadow-lg shadow-red-950/20 transition hover:border-red-300/60 hover:from-red-400/30 hover:to-rose-500/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-35"
                          >
                            <ArrowDown className="h-4 w-4" />
                            <span>Demote</span>
                            {demotedRole && <span className="hidden text-xs font-medium text-red-100/70 sm:inline">to {demotedRole}</span>}
                          </button>
                        </div>
                      )}
                      {(member.role === 'clansman' || member.role === 'guardian') && (
                        <button disabled={busyId === member._id} onClick={() => removeMember(member)} title={`Remove ${member.nickname}`} className="inline-flex items-center justify-center rounded-lg border border-red-500/40 px-3 py-2 text-red-300 hover:bg-red-500/10 disabled:opacity-50">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

      </div>
    </main>
  );
}