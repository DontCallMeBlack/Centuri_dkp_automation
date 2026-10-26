'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, clearClientData, getData, invalidateData, peekData } from '@/lib/client/api';
import RoleBadge, { RoleIcon } from '@/components/RoleBadge';
import LoadingSurface from '@/components/LoadingSurface';
import Dialog from '@/components/Dialog';
import ClanToonsPanel from '@/components/ClanToonsPanel';
import { CLAN_ROLES, canChangeMemberRole } from '@/lib/auth/permissions';
import { useAutoRefresh } from '@/lib/client/useAutoRefresh';
import { ArrowDown, ArrowRightLeft, ArrowUp, Check, ClipboardList, History, Link2, LoaderCircle, Plus, Search, Shield, Swords, Trash2, Undo2, UserCheck, Users, X } from 'lucide-react';
import { getActionRequestId, completeActionRequest } from '@/lib/client/actionRequests';

interface ClanUser {
  _id: string;
  nickname: string;
  role: string;
  sheetRecordRows?: number[];
  needsLinkRefresh?: boolean;
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
  targetUserId?: string;
  transferToUserId?: string;
  operationKey?: string;
  eventType: 'promotion' | 'demotion' | 'member-removal' | 'toon-links' | 'toon-reference-refresh' | 'account-approval' | 'account-denial' | 'toon-created' | 'toon-restored' | 'toon-removed' | 'toon-dkp-wiped' | 'toon-transferred';
  actorNickname: string;
  actorRole: string;
  targetNickname: string;
  previousRole: string;
  newRole?: string;
  createdAt: string;
  addedToons?: Array<{owner:string; account:string}>;
  removedToons?: Array<{rowIndex?:number; owner:string; account:string}>;
  affectedToon?: {rowIndex?:number; owner:string; account:string};
  forfeitedDkp?: string[];
  transferToNickname?: string;
  transferStatus?: 'pending' | 'completed';
  dkpBefore?: string[];
  withdrawnBids?: number;
  promotedBids?: number;
  undoneAt?: string;
  undoneByNickname?: string;
  undoAvailable?: boolean;
}

interface ArchivedAccount {
  id: string;
  auditEventId: string;
  nickname: string;
  role: string;
  originalStatus: 'approved' | 'pending';
  archiveReason: 'member-removal' | 'account-denial';
  linkedToons: Array<{ owner: string; account: string }>;
  archivedAt: string;
  archivedByNickname: string;
}

interface ArchivedToon {
  id: string;
  eventId?: string;
  owner: string;
  account: string;
  subClass: string;
  available: string;
  archivedAt: string;
  archivedByNickname: string;
}

function auditSummary(event: ClanAuditEntry) {
  const toon = event.affectedToon ?? event.addedToons?.[0] ?? event.removedToons?.[0];
  const toonName = toon?.account || toon?.owner || 'Toon';
  const actor = event.actorNickname || 'A manager';
  const target = event.targetNickname || 'account';
  switch (event.eventType) {
    case 'toon-restored': return `${actor} restored ${toonName}`;
    case 'toon-created': return `${actor} added ${toonName}`;
    case 'toon-removed': return `${actor} removed ${toonName}`;
    case 'toon-dkp-wiped': return `${actor} wiped ${target} DKP`;
    case 'toon-transferred': return `${actor} transferred ${toonName} to ${event.transferToNickname || 'another account'}`;
    case 'member-removal': return `${actor} removed ${target}'s account`;
    case 'toon-links': return `${actor} updated ${target}'s toon links`;
    case 'toon-reference-refresh': return `${actor} refreshed ${target}'s toon links`;
    case 'account-approval': return `${actor} approved ${target} account`;
    case 'account-denial': return `${actor} denied ${target}'s sign-up`;
    case 'promotion': return `${actor} promoted ${target} to ${event.newRole || 'a higher role'}`;
    case 'demotion': return `${actor} demoted ${target} to ${event.newRole || 'a lower role'}`;
  }
}
function isUndoableActivity(event: ClanAuditEntry) {
  if (event.undoneAt) return false;
  if (event.undoAvailable !== undefined) return event.undoAvailable;
  if (event.eventType === 'promotion' || event.eventType === 'demotion' || event.eventType === 'account-approval' || event.eventType === 'toon-created') return true;
  return event.eventType === 'toon-links' && Boolean(event.addedToons?.length || event.removedToons?.length);
}

type ClanRole = 'chief' | 'general' | 'guardian' | 'clansman';

type AdminSection = 'requests' | 'members' | 'toons' | 'activity' | 'archive';
const ROLE_DETAILS: Record<ClanRole, string> = {
  chief: 'Full clan administration, member access, DKP awards and auctions.',
  general: 'Manage members, promote Guardians, record kills and manage auctions.',
  guardian: 'Record boss kills, manage catalog items and post auctions.',
  clansman: 'View the roster and bid using linked toons.',
};
interface AdminData {managerRole:ClanRole; managerId:string; pendingUsers:ClanUser[]; members:ClanUser[]; auditEvents:ClanAuditEntry[]; roster:RosterMember[]; archivedAccounts:ArchivedAccount[]; archivedToons:ArchivedToon[]}

export default function AdminRequestsPage() {
  const initialAdminData = peekData<AdminData>('/api/admin/requests');
  const mountedRef = useRef(true);
  const loadSequence = useRef(0);
  const dirtyMappings = useRef(new Set<string>());
  const mutationPending = useRef(false);
  const originalMappings = useRef<Record<string, number[]>>({});
  const [section, setSection] = useState<AdminSection>('requests');
  const [pendingUsers, setPendingUsers] = useState<ClanUser[]>(() => initialAdminData?.pendingUsers ?? []);
  const [members, setMembers] = useState<ClanUser[]>(() => initialAdminData?.members ?? []);
  const [auditEvents, setAuditEvents] = useState<ClanAuditEntry[]>(() => initialAdminData?.auditEvents ?? []);
  const [roster, setRoster] = useState<RosterMember[]>(() => initialAdminData?.roster ?? []);
  const [archivedAccounts, setArchivedAccounts] = useState<ArchivedAccount[]>(() => initialAdminData?.archivedAccounts ?? []);
  const [archivedToons, setArchivedToons] = useState<ArchivedToon[]>(() => initialAdminData?.archivedToons ?? []);
  const [selectedMappings, setSelectedMappings] = useState<Record<string, number[]>>(() => Object.fromEntries([...(initialAdminData?.pendingUsers ?? []), ...(initialAdminData?.members ?? [])].map((member) => [member._id, member.sheetRecordRows ?? []])));
  const [mappingQueries, setMappingQueries] = useState<Record<string, string>>({});
  const [editingToonsFor, setEditingToonsFor] = useState('');
  const [toonTransfer, setToonTransfer] = useState<{ source: ClanUser; toon: RosterMember } | null>(null);
  const [transferDestination, setTransferDestination] = useState('');
  const [transferConfirmed, setTransferConfirmed] = useState(false);
  const [roleEditor, setRoleEditor] = useState<{ memberId: string; selected: ClanRole } | null>(null);
  const [loading, setLoading] = useState(() => !initialAdminData);
  const [accessRole, setAccessRole] = useState('');
  const [managerRole, setManagerRole] = useState<ClanRole | ''>(() => initialAdminData?.managerRole ?? '');
  const [managerId, setManagerId] = useState(() => initialAdminData?.managerId ?? '');
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const router = useRouter();

  const applyData = (data:AdminData) => {
    setManagerRole(data.managerRole ?? ''); setManagerId(data.managerId ?? '');
    setPendingUsers(data.pendingUsers); setMembers(data.members); setAuditEvents(data.auditEvents); setRoster(data.roster);
    setArchivedAccounts(data.archivedAccounts ?? []); setArchivedToons(data.archivedToons ?? []);
    setSelectedMappings((current) => Object.fromEntries([...data.pendingUsers,...data.members].map((member) => [member._id,dirtyMappings.current.has(member._id) ? current[member._id] ?? member.sheetRecordRows ?? [] : member.sheetRecordRows ?? []])));
  };
  const loadData = async () => {
    if (!mountedRef.current) return;
    const sequence = ++loadSequence.current;
    try { const data=await getData<AdminData>('/api/admin/requests'); if (mountedRef.current && sequence === loadSequence.current) { applyData(data); setAccessRole(''); setError(''); } }
    catch (cause) {
      if (!mountedRef.current || sequence !== loadSequence.current) return;
      if (cause instanceof ApiError && cause.status === 499) return;
      if (cause instanceof ApiError && cause.status === 401) { clearClientData(); router.replace('/login'); }
      else if (cause instanceof ApiError && cause.status === 403) setAccessRole(typeof cause.details?.role === 'string' ? cause.details.role : 'member');
      else setError(cause instanceof Error ? cause.message : 'Clan administration could not be refreshed. Showing the last known data.');
      return false;
    } finally { if (mountedRef.current && sequence === loadSequence.current) setLoading(false); }
  };
  useEffect(() => {
    mountedRef.current=true;
    const clear = () => {
      loadSequence.current += 1; dirtyMappings.current.clear();
      setPendingUsers([]); setMembers([]); setAuditEvents([]); setRoster([]);
      setArchivedAccounts([]); setArchivedToons([]);
      setSelectedMappings({}); setMappingQueries({}); setEditingToonsFor('');
      setRoleEditor(null);
      setToonTransfer(null); setTransferDestination(''); setTransferConfirmed(false);
      setManagerRole(''); setManagerId(''); setAccessRole(''); setBusyId('');
      setError(''); setNotice(''); setLoading(true);
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
    setNotice('Applying change to clan records…');
    const previousPendingUsers = pendingUsers;
    const previousMembers = members;
    const target = [...pendingUsers, ...members].find((member) => member._id === userId);

    if (target) {
      if (action === 'approve') {
        setPendingUsers((current) => current.filter((member) => member._id !== userId));
        setMembers((current) => [...current.filter((member) => member._id !== userId), { ...target, role: 'clansman', sheetRecordRows: sheetRecordRows ?? [] }]);
      } else if (action === 'deny' || action === 'remove') {
        setPendingUsers((current) => current.filter((member) => member._id !== userId));
        setMembers((current) => current.filter((member) => member._id !== userId));
      } else if (action === 'set-role' && role) {
        setMembers((current) => current.map((member) => member._id === userId ? { ...member, role } : member));
      } else if (action === 'link' || action === 'unlink') {
        const nextRows = action === 'unlink'
          ? (target.sheetRecordRows ?? []).filter((rowIndex) => !sheetRecordRows?.includes(rowIndex))
          : sheetRecordRows ?? [];
        setMembers((current) => current.map((member) => member._id === userId ? { ...member, sheetRecordRows: nextRows } : member));
      }
    }
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
      void loadData();
      return true;
    } catch (actionError) {
      setPendingUsers(previousPendingUsers);
      setMembers(previousMembers);
      setNotice('');
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
    const accounts = [...members, ...pendingUsers];
    const currentMember = accounts.find((member) => member._id === userId);
    const occupiedRows = new Set(accounts.filter((member) => member._id !== userId).flatMap((member) => member.sheetRecordRows ?? []));
    const availableRoster = roster.filter((record) =>
      !occupiedRows.has(record.rowIndex),
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
    if (window.confirm(`Remove ${member.nickname}'s account? It can be restored from the Archive.`)) {
      void sendAdminAction(member._id, 'remove');
    }
  };

  const unlinkToon = (member: ClanUser, record: RosterMember) => {
    const toonName = record.account || record.owner;
    if (window.confirm(`Unlink ${toonName} from ${member.nickname}? It will become available to link to another account.`)) {
      void sendAdminAction(member._id, 'unlink', [record.rowIndex]);
    }
  };

  const transferToon = async () => {
    if (!toonTransfer || !transferDestination || mutationPending.current || !managerId) return;
    const { source, toon } = toonTransfer;
    const payload = { toUserId: transferDestination, rowIndex: toon.rowIndex, owner: toon.owner, account: toon.account };
    mutationPending.current = true;
    setBusyId(source._id); setError(''); setNotice('Resetting DKP, moving the toon and updating open bids…');
    try {
      const requestId = await getActionRequestId(managerId, 'toon-transfer', payload);
      const response = await fetch('/api/admin/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: source._id, action: 'transfer', ...payload, requestId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The toon could not be transferred.');
      await completeActionRequest(managerId, 'toon-transfer', payload);
      setNotice(result.message || 'Toon transferred and its DKP reset to 0.');
      setToonTransfer(null); setTransferDestination(''); setTransferConfirmed(false);
      for (const url of ['/api/admin/requests', '/api/auth/session', '/api/auction', '/api/dkp']) invalidateData(url);
      void loadData();
    } catch (cause) {
      setNotice('');
      setError(cause instanceof Error ? cause.message : 'The transfer could not be confirmed. Retry the same action.');
      invalidateData('/api/admin/requests');
      void loadData();
    } finally { mutationPending.current = false; setBusyId(''); }
  };

  const resumePendingTransfer = async (event: ClanAuditEntry) => {
    const toon = event.removedToons?.[0];
    const operationParts = event.operationKey?.split(':') ?? [];
    if (mutationPending.current || !managerId || !toon || typeof toon.rowIndex !== 'number' || !event.targetUserId || !event.transferToUserId ||
      operationParts.length !== 3 || operationParts[0] !== 'transfer') return;
    const payload = { toUserId: event.transferToUserId, rowIndex: toon.rowIndex, owner: toon.owner, account: toon.account };
    const requestId = operationParts[2];
    mutationPending.current = true; setBusyId(event.targetUserId); setError(''); setNotice('Resuming toon transfer…');
    try {
      const response = await fetch('/api/admin/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: event.targetUserId, action: 'transfer', ...payload, requestId, resumeOperationKey: event.operationKey }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The transfer could not be resumed.');
      await completeActionRequest(managerId, 'toon-transfer', payload);
      setNotice(result.message || 'Toon transfer completed and DKP reset to 0.');
      for (const url of ['/api/admin/requests', '/api/auth/session', '/api/auction', '/api/dkp']) invalidateData(url);
      void loadData();
    } catch (cause) {
      setNotice(''); setError(cause instanceof Error ? cause.message : 'The transfer could not be resumed.');
      invalidateData('/api/admin/requests'); void loadData();
    } finally { mutationPending.current = false; setBusyId(''); }
  };

  const undoActivity = async (event: ClanAuditEntry) => {
    if (!managerId || !isUndoableActivity(event) || mutationPending.current) return;
    const summary = auditSummary(event);
    const confirmation = event.eventType === 'toon-transferred'
      ? `Undo “${summary}”? Its saved DKP will be restored; withdrawn auction bids will stay withdrawn.`
      : `Undo “${summary}”?`;
    if (!window.confirm(confirmation)) return;
    const payload = { eventId: event.id };
    mutationPending.current = true;
    setBusyId(`undo:${event.id}`); setError(''); setNotice('Undoing change…');
    try {
      const requestId = await getActionRequestId(managerId, 'undo-activity', payload);
      const response = await fetch('/api/admin/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undo-activity', ...payload, requestId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The change could not be undone.');
      await completeActionRequest(managerId, 'undo-activity', payload);
      setNotice(result.message || 'Change undone.');
      for (const url of ['/api/admin/requests', '/api/auth/session', '/api/auction', '/api/dkp']) invalidateData(url);
      void loadData();
    } catch (cause) {
      setNotice('');
      setError(cause instanceof Error ? cause.message : 'The change could not be undone.');
      invalidateData('/api/admin/requests');
      void loadData();
    } finally { mutationPending.current = false; setBusyId(''); }
  };

  const restoreArchivedAccount = async (archive: ArchivedAccount) => {
    if (!managerId || mutationPending.current || !window.confirm(`Restore ${archive.nickname}'s account and saved credentials?`)) return;
    const payload = { eventId: archive.auditEventId };
    mutationPending.current = true; setBusyId(`restore-account:${archive.id}`); setError(''); setNotice('Restoring account…');
    try {
      const requestId = await getActionRequestId(managerId, 'restore-account', payload);
      const response = await fetch('/api/admin/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore-account', ...payload, requestId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The account could not be restored.');
      await completeActionRequest(managerId, 'restore-account', payload);
      setNotice(result.message || 'Account restored.');
      for (const url of ['/api/admin/requests', '/api/auth/session', '/api/auction', '/api/dkp']) invalidateData(url);
      void loadData();
    } catch (cause) {
      setNotice(''); setError(cause instanceof Error ? cause.message : 'The account could not be restored.');
      invalidateData('/api/admin/requests'); void loadData();
    } finally { mutationPending.current = false; setBusyId(''); }
  };

  const restoreArchivedToon = async (archive: ArchivedToon) => {
    if (!managerId || mutationPending.current || !window.confirm(`Restore ${archive.account || archive.owner} with its saved DKP? Auction bids will stay withdrawn.`)) return;
    const payload = { archiveMutationId: archive.id };
    mutationPending.current = true; setBusyId(`restore-toon:${archive.id}`); setError(''); setNotice('Restoring toon…');
    try {
      const requestId = await getActionRequestId(managerId, 'restore-archived-toon', payload);
      const response = await fetch('/api/admin/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore-toon', ...payload, requestId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The toon could not be restored.');
      await completeActionRequest(managerId, 'restore-archived-toon', payload);
      setNotice(result.message || 'Toon restored.');
      for (const url of ['/api/admin/requests', '/api/auth/session', '/api/auction', '/api/dkp']) invalidateData(url);
      void loadData();
    } catch (cause) {
      setNotice(''); setError(cause instanceof Error ? cause.message : 'The toon could not be restored.');
      invalidateData('/api/admin/requests'); void loadData();
    } finally { mutationPending.current = false; setBusyId(''); }
  };

  const updateRole = (member: ClanUser, role: ClanRole) => {
    setError('');
    setRoleEditor({ memberId: member._id, selected: role });
  };

  const getAdjacentRole = (role: string, direction: 'promote' | 'demote'): ClanRole | undefined => {
    const hierarchy: ClanRole[] = ['chief', 'general', 'guardian', 'clansman'];
    const currentIndex = hierarchy.indexOf(role as ClanRole);
    if (currentIndex < 0) return undefined;
    return hierarchy[currentIndex + (direction === 'promote' ? -1 : 1)];
  };

  if (loading) {
    return <LoadingSurface fullLayout label="Preparing clan administration" title="Good people. Stronger clan." />;
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
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p className="page-kicker">Clan leadership</p><h1 className="page-title">Good people. Stronger clan.</h1><p className="page-description">Welcome new members, connect their toons, and manage access.</p></div></div>
      <div className="grid grid-cols-3 gap-3">{[[UserCheck,'Awaiting approval',pendingUsers.length],[Users,'Clan members',members.length],[ClipboardList,'Recorded actions',auditEvents.length]].map(([Icon,label,count]) => { const I=Icon as typeof Users; return <div key={String(label)} className="surface stat-card"><span className="stat-icon hidden sm:block"><I size={17} /></span><div><p className="stat-label">{String(label)}</p><p className="stat-value">{Number(count)}</p></div></div>; })}</div>
      <div className="surface p-5 sm:p-6">
        <nav aria-label="Administration sections" className="section-tabs !mt-0">
          {([
            ['requests', 'Sign-up requests', UserCheck, pendingUsers.length],
            ['members', 'Members', Users, members.length],
            ['toons', 'Clan toons', Shield, roster.length],
            ['activity', 'Activity log', History, auditEvents.length],
            ['archive', 'Archive', Undo2, archivedAccounts.length + archivedToons.length],
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
        {busyId && <p role="status" aria-live="polite" className="mt-5 flex items-center gap-2 rounded-lg border border-indigo-400/20 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-200"><LoaderCircle size={15} className="animate-spin" />{notice || 'Saving clan changes…'}</p>}
        {!busyId && notice && <p role="status" className="mt-5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>}

        <section className="tab-panel-content" hidden={section !== 'toons'} aria-label="Manage clan toons"><ClanToonsPanel active={section === 'toons'} accountId={managerId} onChanged={loadData} /></section>

        {section === 'requests' && (
          <section className="tab-panel-content mt-6 space-y-3">
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
          <section className="tab-panel-content mt-6">
            <div className="mb-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p className="page-kicker">Members</p><h2 className="mt-1 text-xl font-bold tracking-tight text-white">Approved accounts</h2></div><label className="search-field sm:w-72"><Search /><input aria-label="Search approved accounts" type="search" placeholder="Find a clan member..." value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} /></label></div>
            <p className="mb-5 text-xs text-slate-500">Toons linked elsewhere stay hidden until unlinked.</p>
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
                  <article key={member._id} className="group member-account-card p-4 sm:p-5">
                    <div aria-hidden="true" className="pointer-events-none absolute -right-12 -top-16 h-40 w-40 rounded-full bg-indigo-400/[.06] blur-3xl transition group-hover:bg-indigo-300/[.1]" />
                    <div className="relative grid min-w-0 gap-5 md:grid-cols-[minmax(12rem,.8fr)_minmax(0,1.2fr)] md:items-center 2xl:grid-cols-[minmax(14rem,.85fr)_minmax(0,1.15fr)_auto]">
                      <div className="flex min-w-0 items-center gap-4">
                        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-indigo-300/15 bg-indigo-400/[.08] text-indigo-200 shadow-inner shadow-indigo-300/[.04]"><RoleIcon role={member.role} className="h-5 w-5" /></span>
                        <div className="min-w-0"><h3 className="truncate text-xl font-bold tracking-tight text-white sm:text-2xl">{member.nickname}</h3><div className="mt-2 flex flex-wrap items-center gap-2"><RoleBadge role={member.role} /><span className="text-[10px] font-medium text-slate-500">{(member.sheetRecordRows ?? []).length} linked</span></div></div>
                      </div>

                      <div className="min-w-0">
                        <div className="flex min-h-9 flex-wrap items-center gap-2">
                          {(member.sheetRecordRows ?? []).flatMap((rowIndex) => {
                            const record = roster.find((entry) => entry.rowIndex === rowIndex);
                            if (!record) return [];
                            return <span key={rowIndex} className="inline-flex max-w-full items-center gap-1.5 rounded-xl border border-white/[.07] bg-slate-950/45 py-1.5 pl-3 pr-1.5 text-xs font-medium text-slate-200 shadow-inner shadow-black/10">
                              <span className="max-w-40 truncate">{record.account || record.owner}</span>
                              {members.length > 1 && <button type="button" onClick={() => { setToonTransfer({ source: member, toon: record }); setTransferDestination(''); setTransferConfirmed(false); setError(''); }} disabled={busyId !== ''} aria-label={`Transfer ${record.account || record.owner} from ${member.nickname}`} title="Transfer toon" className="grid h-6 w-6 place-items-center rounded-lg text-indigo-300/70 transition hover:bg-indigo-400/10 hover:text-indigo-100 disabled:opacity-40"><ArrowRightLeft className="h-3.5 w-3.5" /></button>}
                              <button type="button" onClick={() => unlinkToon(member, record)} disabled={busyId === member._id} aria-label={`Unlink ${record.account || record.owner} from ${member.nickname}`} title="Unlink toon" className="grid h-6 w-6 place-items-center rounded-lg text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-200 disabled:opacity-40"><X className="h-3.5 w-3.5" /></button>
                            </span>;
                          })}
                          {(member.sheetRecordRows ?? []).length === 0 && <span className="text-xs text-slate-500">No toons linked</span>}
                        </div>
                        <button type="button" aria-haspopup="dialog" disabled={busyId !== ''} onClick={() => editToons(member)} className="mt-2.5 inline-flex min-h-9 items-center gap-2 rounded-xl border border-indigo-300/15 bg-indigo-400/[.05] px-3.5 text-xs font-semibold text-indigo-200 transition hover:border-indigo-300/35 hover:bg-indigo-400/[.1] disabled:cursor-wait disabled:opacity-40">
                          <Link2 className="h-3.5 w-3.5" />{(member.sheetRecordRows ?? []).length ? 'Manage toons' : 'Link toons'}<Plus className="h-3.5 w-3.5 text-indigo-300/60" />
                        </button>
                      </div>

                      <div className="flex min-w-0 flex-wrap items-center gap-2 md:col-span-2 md:justify-end 2xl:col-span-1">
                        {canManageRole && <>
                          <button type="button" disabled={busyId === member._id || !canPromote} onClick={() => promotedRole && updateRole(member, promotedRole)} title={promotedRole ? `Promote to ${promotedRole}` : 'Cannot promote'} className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-xl border border-emerald-400/20 bg-emerald-400/[.05] px-3.5 text-xs font-semibold text-emerald-200 transition hover:border-emerald-300/40 hover:bg-emerald-400/10 disabled:cursor-not-allowed disabled:opacity-35">
                            {busyId === member._id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}<span>Promote</span>{promotedRole && <span className="text-[10px] font-medium text-emerald-100/65">→ {promotedRole}</span>}
                          </button>
                          <button type="button" disabled={busyId === member._id || !canDemote} onClick={() => demotedRole && updateRole(member, demotedRole)} title={demotedRole ? `Demote to ${demotedRole}` : 'Cannot demote'} className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-xl border border-rose-400/20 bg-rose-400/[.04] px-3.5 text-xs font-semibold text-rose-200 transition hover:border-rose-300/40 hover:bg-rose-400/[.08] disabled:cursor-not-allowed disabled:opacity-35">
                            <ArrowDown className="h-3.5 w-3.5" /><span>Demote</span>{demotedRole && <span className="text-[10px] font-medium text-rose-100/65">→ {demotedRole}</span>}
                          </button>
                        </>}
                        {(member.role === 'clansman' || member.role === 'guardian') && <button type="button" disabled={busyId === member._id} onClick={() => removeMember(member)} title={`Remove ${member.nickname}`} aria-label={`Remove ${member.nickname} from the clan`} className="grid h-9 w-9 place-items-center rounded-xl border border-rose-400/20 bg-rose-400/[.04] text-rose-200 transition hover:border-rose-300/40 hover:bg-rose-400/[.1] disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>}
                      </div>
                    </div>
                  </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {section === 'activity' && (
          <section className="tab-panel-content mt-6">
            <h2 className="mb-5 text-lg font-bold text-white">Activity</h2>
            {auditEvents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-800 py-12 text-center">
                <History className="mx-auto h-6 w-6 text-slate-600" />
                <p className="mt-3 text-sm text-slate-400">No activity yet.</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-800">
                <div className="divide-y divide-slate-800">
                  {auditEvents.map((event) => (
                    <article key={event.id} className="flex flex-col gap-3 bg-slate-950/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold text-slate-100">{auditSummary(event)}</p>
                        <p className="mt-1 text-xs text-slate-500">{new Date(event.createdAt).toLocaleString()}</p>
                        {event.eventType === 'toon-transferred' && event.transferStatus === 'pending' && <button type="button" disabled={busyId !== ''} onClick={() => void resumePendingTransfer(event)} className="mt-2 inline-flex min-h-8 items-center gap-2 rounded-lg border border-amber-300/20 bg-amber-300/[.06] px-3 text-xs font-semibold text-amber-100 hover:bg-amber-300/[.12] disabled:opacity-40"><ArrowRightLeft size={13} />Resume transfer</button>}
                      </div>
                      <button type="button" onClick={() => void undoActivity(event)} disabled={!isUndoableActivity(event) || busyId !== ''}
                        title={event.undoneAt ? 'Already undone' : isUndoableActivity(event) ? 'Undo this change' : 'Cannot be undone safely'}
                        aria-label={`Undo ${auditSummary(event)}`}
                        className={`inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-semibold transition disabled:cursor-not-allowed ${event.undoneAt ? 'border-amber-300/15 bg-amber-300/[.04] text-amber-200/60' : isUndoableActivity(event) ? 'border-indigo-300/20 bg-indigo-400/[.08] text-indigo-100 hover:bg-indigo-400/[.16] disabled:opacity-40' : 'border-white/5 bg-white/[.02] text-slate-600'}`}>
                        {busyId === `undo:${event.id}` ? <LoaderCircle size={14} className="animate-spin" /> : <Undo2 size={14} />}
                        {event.undoneAt ? 'Undone' : 'Undo'}
                      </button>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {section === 'archive' && (
          <section className="tab-panel-content mt-6 space-y-8">
            <div>
              <h2 className="mb-4 text-lg font-bold text-white">Removed toons</h2>
              {archivedToons.length === 0 ? <p className="border-y border-slate-800 py-8 text-center text-sm text-slate-500">No removed toons.</p> : (
                <div className="divide-y divide-slate-800 rounded-xl border border-slate-800">
                  {archivedToons.map((toon) => <article key={toon.id} className="flex flex-col gap-3 bg-slate-950/40 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0"><h3 className="truncate font-semibold text-white">{toon.account || toon.owner}</h3>
                      <p className="mt-1 text-xs text-slate-400">{toon.owner}{toon.subClass ? ` · ${toon.subClass}` : ''} · {toon.available} Available DKP</p>
                      <p className="mt-1 text-xs text-slate-600">Removed by {toon.archivedByNickname} · {new Date(toon.archivedAt).toLocaleDateString()}</p>
                    </div>
                    <button type="button" disabled={busyId !== ''} onClick={() => void restoreArchivedToon(toon)} className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-indigo-300/20 bg-indigo-400/[.08] px-3 text-xs font-semibold text-indigo-100 hover:bg-indigo-400/[.16] disabled:opacity-40">
                      {busyId === `restore-toon:${toon.id}` ? <LoaderCircle size={14} className="animate-spin" /> : <Undo2 size={14} />} Restore toon
                    </button>
                  </article>)}
                </div>
              )}
            </div>
            <div>
              <h2 className="mb-4 text-lg font-bold text-white">Removed accounts and denied sign-ups</h2>
              {archivedAccounts.length === 0 ? <p className="border-y border-slate-800 py-8 text-center text-sm text-slate-500">No archived accounts.</p> : (
                <div className="divide-y divide-slate-800 rounded-xl border border-slate-800">
                  {archivedAccounts.map((account) => <article key={account.id} className="flex flex-col gap-3 bg-slate-950/40 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0"><h3 className="truncate font-semibold text-white">{account.nickname}</h3>
                      <p className="mt-1 text-xs capitalize text-slate-400">{account.archiveReason === 'account-denial' ? 'Denied sign-up' : 'Removed member'} · {account.role} · {account.linkedToons.length} toon(s)</p>
                      <p className="mt-1 text-xs text-slate-600">Removed by {account.archivedByNickname} · {new Date(account.archivedAt).toLocaleDateString()}</p>
                    </div>
                    <button type="button" disabled={busyId !== ''} onClick={() => void restoreArchivedAccount(account)} className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-indigo-300/20 bg-indigo-400/[.08] px-3 text-xs font-semibold text-indigo-100 hover:bg-indigo-400/[.16] disabled:opacity-40">
                      {busyId === `restore-account:${account.id}` ? <LoaderCircle size={14} className="animate-spin" /> : <Undo2 size={14} />} Restore account
                    </button>
                  </article>)}
                </div>
              )}
            </div>
          </section>
        )}

      </div>
      {roleEditor && (() => {
        const member = members.find((entry) => entry._id === roleEditor.memberId);
        if (!member) return null;
        const chiefCount = members.filter((entry) => entry.role === 'chief').length;
        const allowed = canChangeMemberRole(managerRole, member.role, roleEditor.selected, member._id === managerId, chiefCount);
        const promoting = CLAN_ROLES.indexOf(roleEditor.selected) < CLAN_ROLES.indexOf(member.role as ClanRole);
        return <Dialog labelledBy="rank-editor-title" onClose={() => setRoleEditor(null)} busy={busyId !== ''} className="!max-w-xl">
          <div className="bg-gradient-to-br from-indigo-500/10 via-transparent to-violet-500/10 p-5 sm:p-7">
            <header className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3"><span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-indigo-300/20 bg-indigo-400/10 text-indigo-200"><RoleIcon role={roleEditor.selected} className="h-6 w-6" /></span><div><p className="page-kicker">Member permissions</p><h2 id="rank-editor-title" className="mt-1 break-all text-lg font-bold text-white">{member.nickname}'s rank</h2></div></div>
              <button type="button" aria-label="Close rank editor" className="icon-button" disabled={busyId !== ''} onClick={() => setRoleEditor(null)}><X size={19} /></button>
            </header>
            <p className="mb-5 mt-4 text-xs leading-6 text-slate-400">Choose a rank to review its access. Changes take effect after you save and are recorded in the activity log.</p>
            <div role="radiogroup" aria-label="Member rank" className="space-y-2">
              {CLAN_ROLES.map((role) => {
                const current = role === member.role;
                const available = current || canChangeMemberRole(managerRole, member.role, role, member._id === managerId, chiefCount);
                const selected = roleEditor.selected === role;
                return <label key={role} className={`flex items-center gap-3 rounded-2xl border p-4 transition ${selected ? 'border-indigo-400/60 bg-indigo-500/15 shadow-lg shadow-indigo-950/30' : 'border-white/5 bg-white/[0.02]'} ${available ? 'cursor-pointer hover:border-indigo-300/30' : 'opacity-35'}`}>
                  <input type="radio" name="member-rank" value={role} checked={selected} disabled={!available || busyId !== ''} onChange={() => setRoleEditor({ memberId: member._id, selected: role })} className="h-4 w-4 accent-indigo-400" />
                  <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><RoleBadge role={role} />{current && <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Current rank</span>}</div><p className="mt-2 text-xs leading-5 text-slate-400">{ROLE_DETAILS[role]}</p></div>
                  {selected && <Check size={18} className="shrink-0 text-indigo-300" />}
                </label>;
              })}
            </div>
            {allowed && <div className={`mt-4 flex flex-wrap items-center gap-2 rounded-xl border p-3 text-xs ${promoting ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-200' : 'border-amber-400/20 bg-amber-400/5 text-amber-200'}`}><span>{promoting ? 'Promote' : 'Demote'}</span><RoleBadge role={member.role} /><span aria-hidden="true">→</span><RoleBadge role={roleEditor.selected} /></div>}
            {error && <p role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}
            <footer className="mt-6 flex justify-end gap-2 border-t border-white/5 pt-5"><button type="button" className="secondary-button" disabled={busyId !== ''} onClick={() => setRoleEditor(null)}>Cancel</button><button type="button" className="primary-button" disabled={busyId !== '' || !allowed} onClick={async () => { if (await sendAdminAction(member._id, 'set-role', undefined, roleEditor.selected)) setRoleEditor(null); }}>{busyId ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}{busyId ? 'Saving rank…' : 'Save rank'}</button></footer>
          </div>
        </Dialog>;
      })()}
      {toonTransfer && <Dialog labelledBy="toon-transfer-title" onClose={() => { if (!mutationPending.current) { setToonTransfer(null); setError(''); } }} busy={busyId !== ''} className="!max-w-lg">
        <div className="bg-gradient-to-br from-indigo-500/10 via-transparent to-violet-500/5 p-5 sm:p-7">
          <header className="mb-5 flex items-start justify-between gap-4">
            <div><p className="page-kicker">Move toon</p><h2 id="toon-transfer-title" className="mt-1 break-all text-xl font-bold text-white">Transfer {toonTransfer.toon.account || toonTransfer.toon.owner}</h2><p className="mt-2 text-xs text-slate-400">From {toonTransfer.source.nickname}</p></div>
            <button type="button" className="icon-button" aria-label="Close transfer dialog" disabled={busyId !== ''} onClick={() => { setToonTransfer(null); setError(''); }}><X size={19} /></button>
          </header>
          <label className="block space-y-2 text-xs font-semibold text-slate-300"><span>New account</span><select value={transferDestination} onChange={(event) => setTransferDestination(event.target.value)} disabled={busyId !== ''} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-white outline-none focus:border-indigo-400"><option value="">Choose an account</option>{members.filter((member) => member._id !== toonTransfer.source._id).map((member) => <option key={member._id} value={member._id}>{member.nickname}</option>)}</select></label>
          <p className="mt-4 rounded-xl border border-indigo-300/15 bg-indigo-400/[.05] p-3 text-xs leading-5 text-slate-300">All DKP fields reset to 0. Open auction bids are withdrawn and the next eligible bid is promoted. Completed auctions and pending mail stay unchanged.</p>
          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 p-3 text-xs leading-5 text-slate-300"><input type="checkbox" checked={transferConfirmed} disabled={busyId !== ''} onChange={(event) => setTransferConfirmed(event.target.checked)} className="mt-1 accent-indigo-400" /><span>I confirm this transfer and full DKP reset.</span></label>
          {error && <p role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}
          <footer className="mt-6 flex justify-end gap-2 border-t border-white/5 pt-5"><button type="button" className="secondary-button" disabled={busyId !== ''} onClick={() => { setToonTransfer(null); setError(''); }}>Cancel</button><button type="button" className="primary-button" disabled={busyId !== '' || !transferDestination || !transferConfirmed} onClick={() => void transferToon()}>{busyId ? <LoaderCircle size={15} className="animate-spin" /> : <ArrowRightLeft size={15} />}{busyId ? 'Transferring…' : 'Transfer & reset DKP'}</button></footer>
        </div>
      </Dialog>}
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
            {member.needsLinkRefresh && <p className="mt-3 rounded-xl border border-amber-300/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-200">The sheet has moved since these links were saved. Save the correct toon selection to refresh this account’s row references.</p>}
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs"><span className="rounded-full border border-indigo-400/20 bg-indigo-500/10 px-3 py-1 text-indigo-200">{selected.length} selected</span>{added > 0 && <span className="text-emerald-300">+{added} linking</span>}{removed > 0 && <span className="text-rose-300">−{removed} unlinking</span>}</div>
            {selected.length === 0 && <p className="mt-3 text-xs text-amber-200">Saving leaves this account with no linked toons. You can add toons again at any time.</p>}
            {error && <p role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}
            <footer className="mt-6 flex flex-wrap justify-end gap-2 border-t border-white/5 pt-5">
              <button type="button" className="secondary-button" disabled={busyId !== ''} onClick={closeToonEditor}>Discard changes</button>
              <button type="button" className="primary-button" disabled={busyId !== '' || (added === 0 && removed === 0 && !member.needsLinkRefresh)} onClick={() => void linkMember(member._id)}>{busyId ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}{busyId ? 'Saving links…' : 'Save toon links'}</button>
            </footer>
          </div>
        </Dialog>;
      })()}
    </main>
  );
}
