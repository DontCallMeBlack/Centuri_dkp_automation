'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Link2, LoaderCircle, Trash2, Users } from 'lucide-react';

interface RosterMember {
  rowIndex: number;
  owner: string;
  account: string;
  subClass: string;
  available: number;
}

interface ManagedUser {
  id: string;
  nickname: string;
  role: string;
  status: 'pending' | 'approved';
  linkedRosterRow: number | null;
  linkedRosterOwner: string;
  linkedRosterAccount: string;
  linkedRosterSubClass: string;
}

export default function AdminPanel() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admin');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load accounts');
      setUsers(data.users);
      setRoster(data.roster);
      setSelections((current) => {
        const updated = { ...current };
        for (const user of data.users as ManagedUser[]) {
          if (!(user.id in updated) && user.linkedRosterRow !== null) {
            updated[user.id] = String(user.linkedRosterRow);
          }
        }
        return updated;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load accounts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const updateAccount = async (user: ManagedUser, action: 'approve' | 'link') => {
    const selectedRow = selections[user.id];
    if (!selectedRow) {
      setError(`Choose a Google Sheets record for ${user.nickname} first.`);
      return;
    }

    setWorkingId(user.id);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, userId: user.id, rosterRowIndex: Number(selectedRow) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to update account');
      setMessage(data.message);
      await loadAccounts();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to update account');
    } finally {
      setWorkingId('');
    }
  };

  const removeAccount = async (user: ManagedUser) => {
    if (!window.confirm(`Remove ${user.nickname}'s account? This will not change the Google Sheets roster.`)) return;

    setWorkingId(user.id);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to remove account');
      setMessage(data.message);
      await loadAccounts();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Unable to remove account');
    } finally {
      setWorkingId('');
    }
  };

  const pendingUsers = users.filter((user) => user.status === 'pending');
  const approvedUsers = users.filter((user) => user.status === 'approved');

  const rosterSelect = (user: ManagedUser) => (
    <select
      value={selections[user.id] ?? ''}
      onChange={(event) => setSelections((current) => ({ ...current, [user.id]: event.target.value }))}
      className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none"
      aria-label={`Google Sheets record for ${user.nickname}`}
    >
      <option value="">Select roster record…</option>
      {roster.map((member) => (
        <option key={member.rowIndex} value={member.rowIndex}>
          {member.owner} — {member.account}{member.subClass ? ` (${member.subClass})` : ''}
        </option>
      ))}
    </select>
  );

  return (
    <section className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-bold text-white">
          <Users className="h-5 w-5 text-indigo-400" />
          Account Administration
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Approve accounts by matching them to a Google Sheets roster record, update links, or remove accounts.
        </p>
      </div>

      {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
      {message && <p role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">{message}</p>}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-14 text-sm text-slate-400">
          <LoaderCircle className="h-4 w-4 animate-spin" /> Loading accounts and Google Sheets roster…
        </div>
      ) : (
        <>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <h3 className="mb-4 font-semibold text-white">Pending approval <span className="text-slate-500">({pendingUsers.length})</span></h3>
            {pendingUsers.length === 0 ? (
              <p className="text-sm text-slate-500">No accounts are waiting for approval.</p>
            ) : (
              <ul className="divide-y divide-slate-800">
                {pendingUsers.map((user) => (
                  <li key={user.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
                    <div className="min-w-36">
                      <p className="font-medium text-slate-100">{user.nickname}</p>
                      <p className="text-xs text-slate-500">Registered account</p>
                    </div>
                    {rosterSelect(user)}
                    <button
                      type="button"
                      onClick={() => void updateAccount(user, 'approve')}
                      disabled={workingId === user.id || roster.length === 0}
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Check className="h-4 w-4" /> Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeAccount(user)}
                      disabled={workingId === user.id}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" /> Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <h3 className="mb-4 font-semibold text-white">Approved accounts <span className="text-slate-500">({approvedUsers.length})</span></h3>
            {approvedUsers.length === 0 ? (
              <p className="text-sm text-slate-500">No approved accounts.</p>
            ) : (
              <ul className="divide-y divide-slate-800">
                {approvedUsers.map((user) => (
                  <li key={user.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
                    <div className="min-w-36">
                      <p className="font-medium text-slate-100">{user.nickname}</p>
                      <p className="text-xs capitalize text-slate-500">{user.role}</p>
                    </div>
                    <div className="min-w-0 flex-1">
                      {rosterSelect(user)}
                      <p className="mt-1 truncate text-xs text-slate-500">
                        Linked: {user.linkedRosterOwner ? `${user.linkedRosterOwner} — ${user.linkedRosterAccount}` : 'No roster record'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void updateAccount(user, 'link')}
                      disabled={workingId === user.id || roster.length === 0}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-indigo-500/30 px-3 py-2 text-sm text-indigo-300 hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Link2 className="h-4 w-4" /> Update link
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeAccount(user)}
                      disabled={workingId === user.id}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" /> Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
