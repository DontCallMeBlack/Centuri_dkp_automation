// app/admin/requests/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, Check, X, UserCheck } from 'lucide-react';

interface PendingUser {
  _id: string;
  nickname: string;
  role: string;
  status: string;
  sheetRecordName?: string;
}

interface RosterMember {
  rowIndex: number;
  owner: string;
  account: string;
}

export default function AdminRequestsPage() {
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [selectedMappings, setSelectedMappings] = useState<{ [userId: string]: string }>({});
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const fetchData = async () => {
    try {
      const res = await fetch('/api/admin/requests');
      if (res.status === 401 || res.status === 403) {
        router.push('/dashboard');
        return;
      }
      const data = await res.json();
      if (data.success) {
        setPendingUsers(data.pendingUsers);
        setRoster(data.roster);
      }
    } catch (err) {
      console.error('Failed to load pending requests', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleApprove = async (userId: string) => {
    const sheetRecordName = selectedMappings[userId];
    if (!sheetRecordName) {
      alert('Please select a corresponding Google Sheet record name to link this user.');
      return;
    }

    try {
      const res = await fetch('/api/admin/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, sheetRecordName, action: 'approve' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      alert('User approved and mapped successfully!');
      fetchData();
    } catch (err: any) {
      alert(err.message || 'Approval failed');
    }
  };

  const handleReject = async (userId: string) => {
    try {
      await fetch('/api/admin/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action: 'reject' }),
      });
      fetchData();
    } catch (err) {
      alert('Action failed');
    }
  };

  if (loading) return <div className="p-8 text-white bg-[#07090e] min-h-screen">Loading requests...</div>;

  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100 p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <header className="flex justify-between items-center border-b border-slate-800 pb-4">
          <div className="flex items-center space-x-3">
            <Shield className="w-6 h-6 text-indigo-400" />
            <h1 className="text-xl font-bold text-white">Clan Sign-Up Requests & Sheet Mapping</h1>
          </div>
          <button
            onClick={() => router.push('/dashboard')}
            className="text-xs bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-xl text-slate-300 transition"
          >
            Back to Dashboard
          </button>
        </header>

        <div className="space-y-4">
          {pendingUsers.length === 0 ? (
            <p className="text-slate-500 text-sm py-8 text-center bg-slate-900/40 rounded-2xl border border-slate-800/60">
              No pending sign-up requests.
            </p>
          ) : (
            pendingUsers.map((user) => (
              <div key={user._id} className="bg-slate-900/80 border border-slate-800 p-5 rounded-2xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                  <h2 className="font-bold text-lg text-white">{user.nickname}</h2>
                  <p className="text-xs text-slate-400">Requested account mapping to sheet record</p>
                </div>

                <div className="flex flex-col sm:flex-row items-center gap-3 w-full md:w-auto">
                  <select
                    className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2.5 w-full sm:w-56 focus:outline-none focus:border-indigo-500"
                    value={selectedMappings[user._id] || ''}
                    onChange={(e) => setSelectedMappings({ ...selectedMappings, [user._id]: e.target.value })}
                  >
                    <option value="">Select Sheet Record Name...</option>
                    {roster.map((member, idx) => (
                      <option key={idx} value={member.owner}>
                        {member.owner} ({member.account})
                      </option>
                    ))}
                  </select>

                  <div className="flex items-center gap-2 w-full sm:w-auto">
                    <button
                      onClick={() => handleApprove(user._id)}
                      className="flex-1 sm:flex-none bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                    >
                      <Check className="w-3.5 h-3.5" /> Approve
                    </button>
                    <button
                      onClick={() => handleReject(user._id)}
                      className="flex-1 sm:flex-none bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 px-4 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                    >
                      <X className="w-3.5 h-3.5" /> Reject
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}