// app/admin/requests/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Link2, Shield, Trash2, UserCheck, X } from 'lucide-react';

interface ManagedUser {
  _id: string;
  nickname: string;
  role: string;
  status: string;
  sheetRecordName?: string;
  createdAt: string;
}

interface RosterMember {
  owner: string;
  account: string;
}

export default function AdminRequestsPage() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [selectedMappings, setSelectedMappings] = useState<Record<string, string>>({});
  const [selectedRoles, setSelectedRoles] = useState<Record<string, string>>({});
  const [adminRole, setAdminRole] = useState('');
  const [currentUserId, setCurrentUserId] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingUser, setSavingUser] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const router = useRouter();

  const fetchData = async () => {
    try {
      setError('');
      const res = await fetch('/api/admin/requests');
      if (res.status === 401 || res.status === 403) {
        router.push('/dashboard');
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load user management data.');
      if (data.success) {
        setUsers(data.users);
        setRoster(data.roster);
        setAdminRole(data.adminRole);
        setCurrentUserId(data.currentUserId);
        setSelectedMappings(Object.fromEntries(
          data.users.map((user: ManagedUser) => [user._id, user.sheetRecordName || ''])
        ));
        setSelectedRoles(Object.fromEntries(
          data.users.map((user: ManagedUser) => [user._id, user.role])
        ));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load user management data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleApprove = async (userId: string) => {
    await performAction(userId, 'approve', { sheetRecordName: selectedMappings[userId] || '' });
  };

  const handleReject = async (userId: string) => {
    if (!window.confirm('Reject this signup and remove the account?')) return;
    await performAction(userId, 'reject');
  };

  const handleSaveMapping = async (userId: string) => {
    await performAction(userId, 'link', { sheetRecordName: selectedMappings[userId] || '' });
  };

  const handleSaveRole = async (userId: string) => {
    await performAction(userId, 'set-role', { role: selectedRoles[userId] || '' });
  };

  const handleRemove = async (user: ManagedUser) => {
    if (!window.confirm(`Remove ${user.nickname}'s account? This cannot be undone.`)) return;
    await performAction(user._id, 'delete');
  };

  const performAction = async (
    userId: string,
    action: string,
    extra: Record<string, string> = {}
  ) => {
    setSavingUser(userId);
    setError('');
    setMessage('');
    try {
      const res = await fetch('/api/admin/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'The action failed.');
      setMessage(data.message);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The action failed.');
    } finally {
      setSavingUser(null);
    }
  };

  const pendingUsers = users.filter((user) => user.status === 'pending');
  const linkedRoster = Array.from(
    new Map(roster.map((member) => [member.owner, member])).values()
  );

  if (loading) return <div className="min-h-screen bg-[#07090e] p-8 text-white">Loading users...</div>;

  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100 p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex justify-between items-center border-b border-slate-800 pb-4">
          <div className="flex items-center space-x-3">
            <Shield className="w-6 h-6 text-indigo-400" />
            <div>
              <h1 className="text-xl font-bold text-white">User Management</h1>
              <p className="text-xs text-slate-400 mt-1">Approve signups, link Sheet records, and remove accounts.</p>
            </div>
          </div>
          <button
            onClick={() => router.push('/dashboard')}
            className="text-xs bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-xl text-slate-300 transition"
          >
            Back to Dashboard
          </button>
        </header>

        {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
        {message && <p role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">{message}</p>}

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <UserCheck className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white">Pending signups <span className="text-slate-500">({pendingUsers.length})</span></h2>
          </div>
          {pendingUsers.length === 0 ? (
            <p className="rounded-2xl border border-slate-800/60 bg-slate-900/40 py-6 text-center text-sm text-slate-500">No pending signups.</p>
          ) : pendingUsers.map((user) => (
            <div key={user._id} className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-5 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="font-bold text-white">{user.nickname}</h3>
                <p className="mt-1 text-xs text-slate-400">Signed up {new Date(user.createdAt).toLocaleDateString()}</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  onClick={() => handleApprove(user._id)}
                  disabled={savingUser === user._id}
                  className="flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" /> Approve
                </button>
                <button
                  onClick={() => handleReject(user._id)}
                  disabled={savingUser === user._id}
                  className="flex items-center justify-center gap-1.5 rounded-xl border border-red-600/30 bg-red-600/20 px-4 py-2 text-xs font-semibold text-red-300 transition hover:bg-red-600/30 disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" /> Reject
                </button>
              </div>
            </div>
          ))}
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-indigo-400" />
            <h2 className="font-semibold text-white">Registered users <span className="text-slate-500">({users.length})</span></h2>
          </div>
          {users.length === 0 ? (
            <p className="rounded-2xl border border-slate-800/60 bg-slate-900/40 py-6 text-center text-sm text-slate-500">No registered users yet.</p>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70">
              {users.map((user) => (
                <div key={user._id} className="flex flex-col gap-3 border-b border-slate-800 p-4 last:border-b-0 md:flex-row md:items-center">
                  <div className="min-w-40 flex-1">
                    <h3 className="font-semibold text-white">{user.nickname}</h3>
                    <p className="mt-1 text-xs capitalize text-slate-400">{user.role} · {user.status}</p>
                  </div>
                  {adminRole === 'chief' && user.role !== 'chief' && user._id !== currentUserId && (
                    <div className="flex gap-2">
                      <select
                        aria-label={`Role for ${user.nickname}`}
                        className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2.5 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
                        value={selectedRoles[user._id] || user.role}
                        onChange={(event) => setSelectedRoles({ ...selectedRoles, [user._id]: event.target.value })}
                      >
                        <option value="clansman">Member</option>
                        <option value="general">General</option>
                      </select>
                      <button
                        onClick={() => handleSaveRole(user._id)}
                        disabled={savingUser === user._id || selectedRoles[user._id] === user.role}
                        className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
                      >
                        Save role
                      </button>
                    </div>
                  )}
                  <div className="flex flex-1 flex-col gap-2 sm:flex-row">
                    <select
                      aria-label={`Google Sheets record for ${user.nickname}`}
                      className="min-w-0 flex-1 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2.5 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
                      value={selectedMappings[user._id] || ''}
                      onChange={(event) => setSelectedMappings({ ...selectedMappings, [user._id]: event.target.value })}
                    >
                      <option value="">Not linked to a Sheet record</option>
                      {linkedRoster.map((member) => (
                        <option key={member.owner} value={member.owner}>
                          {member.owner}{member.account ? ` (${member.account})` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => handleSaveMapping(user._id)}
                      disabled={savingUser === user._id || (selectedMappings[user._id] || '') === (user.sheetRecordName || '')}
                      className="flex items-center justify-center gap-1.5 rounded-xl border border-indigo-500/40 bg-indigo-600/20 px-3 py-2 text-xs font-semibold text-indigo-200 transition hover:bg-indigo-600/30 disabled:opacity-40"
                    >
                      <Link2 className="h-3.5 w-3.5" /> Save link
                    </button>
                  </div>
                  {user.status === 'approved' && user.role !== 'chief' && user._id !== currentUserId && (
                    <button
                      onClick={() => handleRemove(user)}
                      disabled={savingUser === user._id}
                      className="flex items-center justify-center gap-1.5 rounded-xl border border-red-600/30 px-3 py-2 text-xs font-semibold text-red-300 transition hover:bg-red-600/10 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}