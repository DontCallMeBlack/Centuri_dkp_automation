'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, clearClientData, getData, invalidateData, peekData } from '@/lib/client/api';
import RoleBadge, { RoleIcon } from '@/components/RoleBadge';
import LoadingSurface from '@/components/LoadingSurface';
import Dialog from '@/components/Dialog';
import { useAutoRefresh } from '@/lib/client/useAutoRefresh';
import { ArrowDown, ArrowUp, Check, ClipboardList, History, Link2, LoaderCircle, Plus, Search, Shield, Swords, Trash2, Unlink, UserCheck, Users, X } from 'lucide-react';

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
  subClass?: string;
}

interface ClanAuditEntry {
  id: string;
  eventType: 'promotion' | 'demotion' | 'member-removal' | 'toon-links' | 'account-approval' | 'account-denial';
  actorNickname: string;
  actorRole: string;
  targetNickname: string;
  previousRole: string;
  newRole?: string;
  createdAt: string;
  addedToons?: Array<{owner:string; account:string}>;
  removedToons?: Array<{owner:string; account:string}>;
}

type ClanRole = 'chief' | 'general' | 'guardian' | 'clansman';

type AdminSection = 'requests' | 'members' | 'activity';
interface AdminData {managerRole:ClanRole; managerId:string; pendingUsers:ClanUser[]; members:ClanUser[]; auditEvents:ClanAuditEntry[]; roster:RosterMember[]}

export default function AdminRequestsPage() {
  const mountedRef = useRef(true);
  const loadSequence = useRef(0);
  const dirtyMappings = useRef(new Set<string>());
  const mutationPending = useRef(false);
  const originalMappings = useRef<Record<string, number[]>>({});
  const [section, setSection] = useState<AdminSection>('requests');
  const [pendingUsers, setPendingUsers] = useState<ClanUser[]>([]);
  const [members, setMembers] = useState<ClanUser[]>([]);
  const [auditEvents, setAuditEvents] = useState<ClanAuditEntry[]>([]);
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
  const [memberQuery, setMemberQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  const applyData = (data:AdminData) => {
    setManagerRole(data.managerRole ?? ''); setManagerId(data.managerId ?? '');
    setPendingUsers(data.pendingUsers); setMembers(data.members); setAuditEvents(data.auditEvents); setRoster(data.roster);
    setSelectedMappings((current) => Object.fromEntries([...data.pendingUsers,...data.members].map((member) => [member._id,dirtyMappings.current.has(member._id) ? current[member._id] ?? member.sheetRecordRows ?? [] : member.sheetRecordRows ?? []])));
  };
  const loadData = async () => {
    if (!mountedRef.current) return;
    const sequence = ++loadSequence.current;
    setRefreshing(true);
    try { const data=await getData<AdminData>('/api/admin/requests'); if (mountedRef.current && sequence === loadSequence.current) { applyData(data); setAccessRole(''); setError(''); } }
    catch (cause) {
      if (!mountedRef.current || sequence !== loadSequence.current) return;
      if (cause instanceof ApiError && cause.status === 499) return;
      if (cause instanceof ApiError && cause.status === 401) { clearClientData(); router.replace('/login'); }
      else if (cause instanceof ApiError && cause.status === 403) setAccessRole(typeof cause.details?.role === 'string' ? cause.details.role : 'member');
      else setError(cause instanceof Error ? cause.message : 'Clan administration could not be refreshed. Showing the last known data.');
      return false;
    } finally { if (mountedRef.current && sequence === loadSequence.current) { setLoading(false); setRefreshing(false); } }
  };
  useEffect(() => {
    mountedRef.current=true;
    const cached=peekData<AdminData>('/api/admin/requests');
    if (cached) { applyData(cached); setLoading(false); }
    const clear = () => {
      loadSequence.current += 1; dirtyMappings.current.clear();
      setPendingUsers([]); setMembers([]); setAuditEvents([]); setRoster([]);
      setSelectedMappings({}); setMappingQueries({}); setEditingToonsFor('');
      setManagerRole(''); setManagerId(''); setAccessRole(''); setBusyId('');
      setError(''); setNotice(''); setLoading(true); setRefreshing(false);
    };
    window.addEventListener('centuri:clear-data',clear);
    return () => { mountedRef.current=false; loadSequence.current += 1; window.removeEventListener('centuri:clear-data',clear); };
  }, []);
  useAutoRefresh(loadData);

  const sendAdminAction = async (
    userId: string,
    action: string,
    sheetRecordRows?: number[],
    role?: ClanRole,
  ) => {
    if (mutationPending.current) return false;
    mutationPending.current = true;
    setBusyId(userId);
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/admin/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action, sheetRecordRows, role,
          ...(action === 'link' ? { expectedSheetRecordRows: originalMappings.current[userId] ?? [] } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'The request could not be completed');
      setNotice(data.message);
      dirtyMappings.current.delete(userId);
      invalidateData('/api/admin/requests');
      invalidateData('/api/auth/session');
      invalidateData('/api/auction');
      invalidateData('/api/dkp');
      await loadData();
      return true;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'The request could not be completed');
      return false;
    } finally {
      mutationPending.current = false;
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
  const linkMember = async (userId: string) => {
    const rows = selectedMappings[userId] ?? [];
    if (await sendAdminAction(userId, 'link', rows)) {
      setEditingToonsFor('');
    }
  };

  const editToons = (member: ClanUser) => {
    if (mutationPending.current) return;
    const rows = [...(member.sheetRecordRows ?? [])];
    originalMappings.current[member._id] = rows;
    dirtyMappings.current.add(member._id);
    setSelectedMappings((current) => ({ ...current, [member._id]: rows }));
    setMappingQueries((current) => ({ ...current, [member._id]: '' }));
    setError('');
    setEditingToonsFor(member._id);
  };

  const closeToonEditor = () => {
    if (mutationPending.current) return;
    dirtyMappings.current.delete(editingToonsFor);
    setEditingToonsFor('');
    setError('');
  };

  const toggleMapping = (userId: string, rowIndex: number) => {
    dirtyMappings.current.add(userId);
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
      <div className="overflow-hidden rounded-2xl border border-indigo-300/15 bg-slate-950/60 shadow-inner shadow-black/20">
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
        <fieldset disabled={busyId !== ''} className="custom-scrollbar max-h-72 overflow-y-auto space-y-1 p-2 disabled:opacity-60">
          <legend className="sr-only">{label}</legend>
          {filteredRoster.map((record) => {
            const isSelected = (selectedMappings[userId] ?? []).includes(record.rowIndex);
            return (
              <label
                key={record.rowIndex}
                className={`relative flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 text-sm transition ${
                  isSelected
                    ? 'border-indigo-400/30 bg-gradient-to-r from-indigo-500/15 to-violet-500/5 text-white'
                    : 'border-transparent text-slate-300 hover:border-white/10 hover:bg-white/5'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleMapping(userId, record.rowIndex)}
                  className="peer sr-only"
                />
                <span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border peer-focus-visible:outline-2 peer-focus-visible:outline-indigo-300 ${isSelected ? 'border-indigo-300/25 bg-indigo-400/15 text-indigo-200' : 'border-white/5 bg-white/5 text-slate-500'}`}><Swords className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium leading-5">
                    {record.account || 'Unnamed toon'} <span className="font-normal text-slate-500">· {record.owner}</span>
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">{record.subClass || 'Clan toon'}{currentMember?.sheetRecordRows?.includes(record.rowIndex) ? ' · Currently linked' : ' · Available to link'}</span>
                </span>
                <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${isSelected ? 'border-indigo-400 bg-indigo-500 text-white' : 'border-slate-700 text-slate-600'}`}>{isSelected ? <Check size={12} /> : <Plus size={12} />}</span>
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
    return hierarchy[currentIndex + (direction === 'promote' ? -1 : 1)];
  };

  if (loading) {
    return <LoadingSurface label="Preparing clan administration" />;
  }

  if (accessRole) {
    return (
      <main className="surface flex min-h-80 items-center justify-center px-5 text-slate-100">
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
    <main className="space-y-6 text-slate-100">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p className="page-kicker">Clan leadership</p><h1 className="page-title">Good people. Stronger clan.</h1><p className="page-description">Welcome new members, connect their toons, and manage access.</p></div><span className="flex items-center gap-2 text-[10px] text-slate-500"><span className={`h-1.5 w-1.5 rounded-full bg-emerald-400 ${refreshing ? 'animate-pulse' : ''}`} />Automatic updates</span></div>
      <div className="grid grid-cols-3 gap-3">{[[UserCheck,'Awaiting approval',pendingUsers.length],[Users,'Clan members',members.length],[ClipboardList,'Recorded actions',auditEvents.length]].map(([Icon,label,count]) => { const I=Icon as typeof Users; return <div key={String(label)} className="surface stat-card"><span className="stat-icon hidden sm:block"><I size={17} /></span><div><p className="stat-label">{String(label)}</p><p className="stat-value">{Number(count)}</p></div></div>; })}</div>
      <div className="surface p-5 sm:p-6">
        <nav aria-label="Administration sections" className="section-tabs !mt-0">
          {([
            ['requests', 'Sign-up requests', UserCheck, pendingUsers.length],
            ['members', 'Members', Users, members.length],
            ['activity', 'Activity log', History, auditEvents.length],
          ] as const).map(([key, label, Icon, count]) => (
            <button
              key={key}
              onClick={() => setSection(key)}
              aria-pressed={section === key}
              className={`section-tab ${section === key ? '!border-indigo-400 !text-indigo-300' : ''}`}
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
                  <div className="min-w-0 flex-1 sm:min-w-56">
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
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><h2 className="text-lg font-semibold text-white">Approved accounts</h2><label className="search-field sm:w-64"><Search /><input aria-label="Search approved accounts" type="search" placeholder="Find a clan member..." value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} /></label></div>
            <p className="mb-4 mt-1 text-sm text-slate-400">Toons linked to another account are hidden. Unlink a toon to make it available for reassignment.</p>
            {members.length === 0 ? <p className="border-y border-slate-800 py-10 text-center text-sm text-slate-500">No approved member accounts.</p> : (
              <div className="space-y-3">
                {members.filter((member) => member.nickname.toLowerCase().includes(memberQuery.trim().toLowerCase())).map((member) => {
                  const promotedRole = getAdjacentRole(member.role, 'promote');
                  const demotedRole = getAdjacentRole(member.role, 'demote');
                  const canManageRole = member._id !== managerId &&
                    (managerRole === 'chief' ||
                      (managerRole === 'general' && member.role !== 'chief' && member.role !== 'general'));
                  const canPromote = promotedRole !== undefined &&
                    (managerRole === 'chief' || (member.role === 'clansman' && promotedRole === 'guardian'));
                  const canDemote = demotedRole !== undefined &&
                    (managerRole === 'chief' || (member.role === 'guardian' && demotedRole === 'clansman')) &&
                    !(member.role === 'chief' && members.filter((entry) => entry.role === 'chief').length <= 1);

                  return (
                  <article key={member._id} className="grid min-w-0 gap-4 rounded-2xl border border-white/5 bg-gradient-to-br from-slate-900/70 to-slate-950/30 p-4 transition hover:border-indigo-300/15 sm:p-5 md:grid-cols-[minmax(10rem,0.8fr)_minmax(14rem,1.2fr)] md:items-start">
                    <div>
                      <div className="flex items-center gap-3"><span className="profile-avatar text-indigo-300"><RoleIcon role={member.role} className="h-4 w-4" /></span><h3 className="text-sm font-semibold text-white">{member.nickname}</h3></div><div className="mt-3 flex flex-wrap items-center gap-2"><RoleBadge role={member.role} /><span className="text-[10px] text-slate-500">{(member.sheetRecordRows ?? []).length} toon(s) linked</span></div>
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
                        aria-haspopup="dialog"
                        disabled={busyId !== ''}
                        onClick={() => editToons(member)}
                        className="mt-3 inline-flex w-full items-center justify-center gap-3 rounded-xl border border-indigo-300/20 bg-gradient-to-r from-indigo-500/15 to-violet-500/10 px-4 py-3 text-sm font-semibold text-indigo-200 shadow-lg shadow-indigo-950/15 transition hover:border-indigo-300/40 hover:from-indigo-500/25 disabled:opacity-40 sm:w-auto"
                      >
                        <span className="inline-flex items-center gap-2">
                          <Link2 className="h-4 w-4 text-indigo-300" />
                          {(member.sheetRecordRows ?? []).length ? 'Manage linked toons' : 'Link a toon'}
                        </span>
                        <Plus className="h-4 w-4 text-indigo-300/60" />
                      </button>
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
                        <button disabled={busyId === member._id} onClick={() => removeMember(member)} title={`Remove ${member.nickname}`} aria-label={`Remove ${member.nickname} from the clan`} className="inline-flex items-center justify-center rounded-lg border border-red-500/40 px-3 py-2 text-red-300 hover:bg-red-500/10 disabled:opacity-50">
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

        {section === 'activity' && (
          <section className="mt-6">
            <div className="mb-5">
              <h2 className="text-lg font-bold text-white">Member access history</h2>
              <p className="mt-1 text-sm text-slate-400">The latest 100 actions: toon links, approvals, role changes, and removals, including who made each change.</p>
            </div>
            {auditEvents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-800 py-12 text-center">
                <History className="mx-auto h-6 w-6 text-slate-600" />
                <p className="mt-3 text-sm text-slate-400">No member access changes have been logged yet.</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-800">
                <div className="divide-y divide-slate-800">
                  {auditEvents.map((event) => (
                    <article key={event.id} className="flex flex-col gap-2 bg-slate-950/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                          event.eventType === 'promotion'
                            ? 'bg-emerald-500/10 text-emerald-300'
                            : event.eventType === 'demotion'
                              ? 'bg-amber-500/10 text-amber-300'
                              : event.eventType === 'toon-links' || event.eventType === 'account-approval'
                                ? 'bg-indigo-500/10 text-indigo-300' : 'bg-red-500/10 text-red-300'
                        }`}>
                          {event.eventType === 'promotion'
                            ? <ArrowUp className="h-4 w-4" />
                            : event.eventType === 'demotion'
                              ? <ArrowDown className="h-4 w-4" />
                              : event.eventType === 'toon-links' ? <Link2 className="h-4 w-4" />
                                : event.eventType === 'account-approval' ? <UserCheck className="h-4 w-4" />
                                  : <Trash2 className="h-4 w-4" />}
                        </span>
                        <div className="min-w-0">
                          <p className="break-words text-sm font-semibold text-slate-100">
                            {event.eventType === 'member-removal'
                              ? <><span className="text-white">{event.targetNickname}</span> was removed from the clan</>
                              : event.eventType === 'toon-links' ? <><span className="text-white">{event.targetNickname}</span> · Toon links updated</>
                                : event.eventType === 'account-approval' ? <><span className="text-white">{event.targetNickname}</span> · Account approved</>
                                  : event.eventType === 'account-denial' ? <><span className="text-white">{event.targetNickname}</span> · Sign-up denied</>
                                    : <><span className="text-white">{event.targetNickname}</span> {event.eventType === 'promotion' ? 'promoted' : 'demoted'} from <span className="capitalize text-slate-300">{event.previousRole}</span> to <span className="capitalize text-slate-300">{event.newRole}</span></>}
                          </p>
                          {!!event.addedToons?.length && <p className="mt-2 flex items-start gap-1.5 text-xs text-emerald-300"><Link2 size={13} className="mt-0.5" /><span>Linked: {event.addedToons.map((toon) => `${toon.account || 'Unnamed toon'} (${toon.owner})`).join(', ')}</span></p>}
                          {!!event.removedToons?.length && <p className="mt-1 flex items-start gap-1.5 text-xs text-rose-300"><Unlink size={13} className="mt-0.5" /><span>Unlinked: {event.removedToons.map((toon) => `${toon.account || 'Unnamed toon'} (${toon.owner})`).join(', ')}</span></p>}
                          <p className="mt-1 text-xs text-slate-500">
                            By <span className="text-slate-300">{event.actorNickname}</span>
                            <span className="capitalize"> · {event.actorRole}</span>
                            {event.eventType === 'member-removal' && <span className="capitalize"> · Was {event.previousRole}</span>}
                          </p>
                        </div>
                      </div>
                      <time className="shrink-0 pl-11 text-xs text-slate-500 sm:pl-0" dateTime={event.createdAt}>
                        {new Date(event.createdAt).toLocaleString()}
                      </time>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

      </div>
      {editingToonsFor && (() => {
        const member = members.find((entry) => entry._id === editingToonsFor);
        if (!member) return null;
        const selected = selectedMappings[member._id] ?? [];
        const original = originalMappings.current[member._id] ?? [];
        const added = selected.filter((row) => !original.includes(row)).length;
        const removed = original.filter((row) => !selected.includes(row)).length;
        return <Dialog labelledBy="toon-editor-title" onClose={closeToonEditor} busy={busyId !== ''} className="!max-w-xl">
          <div className="bg-gradient-to-br from-indigo-500/10 via-transparent to-violet-500/5 p-5 sm:p-7">
            <header className="mb-5 flex items-start justify-between gap-4">
              <div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-indigo-300/20 bg-indigo-400/10 text-indigo-200"><Link2 size={21} /></span><div><p className="page-kicker">Member access</p><h2 id="toon-editor-title" className="mt-1 text-lg font-bold text-white">{member.nickname}’s toons</h2></div></div>
              <button type="button" className="icon-button" aria-label="Close toon editor" disabled={busyId !== ''} onClick={closeToonEditor}><X size={19} /></button>
            </header>
            <p className="mb-4 text-xs leading-6 text-slate-400">Select the toons this account can use. Unlinked toons appear here again immediately after saving. Toons assigned to other accounts are hidden.</p>
            {renderMappingSelector(member._id, `Available toon rows for ${member.nickname}`)}
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs"><span className="rounded-full border border-indigo-400/20 bg-indigo-500/10 px-3 py-1 text-indigo-200">{selected.length} selected</span>{added > 0 && <span className="text-emerald-300">+{added} linking</span>}{removed > 0 && <span className="text-rose-300">−{removed} unlinking</span>}</div>
            {selected.length === 0 && <p className="mt-3 text-xs text-amber-200">Saving leaves this account with no linked toons. You can add toons again at any time.</p>}
            {error && <p role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}
            <footer className="mt-6 flex flex-wrap justify-end gap-2 border-t border-white/5 pt-5">
              <button type="button" className="secondary-button" disabled={busyId !== ''} onClick={closeToonEditor}>Discard changes</button>
              <button type="button" className="primary-button" disabled={busyId !== '' || (added === 0 && removed === 0)} onClick={() => void linkMember(member._id)}>{busyId ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}{busyId ? 'Saving links…' : 'Save toon links'}</button>
            </footer>
          </div>
        </Dialog>;
      })()}
    </main>
  );
}
