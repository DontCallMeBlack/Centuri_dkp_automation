// app/dashboard/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface User {
  _id: string;
  nickname: string;
  role: 'chief' | 'clansman';
  status: 'approved' | 'pending';
}

export default function DashboardPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const router = useRouter();

  const fetchUsers = async () => {
    try {
      const res = await fetch('/api/dkp'); // Fetching clan roster/users
      if (res.status === 401) {
        router.push('/login');
        return;
      }
      const data = await res.json();
      if (res.ok) {
        setUsers(data.users || data);
      } else {
        setError(data.message || 'Failed to fetch roster');
      }
    } catch (err) {
      setError('An error occurred while fetching users.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleAction = async (userId: string, action: 'approve' | 'promote' | 'remove') => {
    try {
      const res = await fetch('/api/dkp', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action }),
      });

      if (res.ok) {
        fetchUsers(); // Refresh list
      } else {
        const data = await res.json();
        alert(data.message || 'Action failed');
      }
    } catch (err) {
      alert('Network error during action.');
    }
  };

  if (loading) return <div className="p-8 text-white bg-slate-950 min-h-screen">Loading Axiom Roster...</div>;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12">
      <div className="max-w-4xl mx-auto">
        <header className="flex justify-between items-center mb-8 border-b border-slate-800 pb-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-amber-500">Axiom Clan Command</h1>
            <p className="text-slate-400 text-sm mt-1">Manage recruit requests, approvals, and member ranks.</p>
          </div>
          <button
            onClick={() => {
              document.cookie = 'token=; Max-Age=0; path=/;';
              router.push('/login');
            }}
            className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded-lg text-sm font-medium transition"
          >
            Log Out
          </button>
        </header>

        {error && <div className="mb-6 p-4 bg-red-950/50 border border-red-800 text-red-200 rounded-lg">{error}</div>}

        <section className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
          <div className="px-6 py-4 border-b border-slate-800 font-semibold text-slate-200">
            Clan Roster & Requests
          </div>
          
          <div className="divide-y divide-slate-800">
            {users.length === 0 ? (
              <div className="p-6 text-center text-slate-500">No members or pending requests found.</div>
            ) : (
              users.map((user) => (
                <div key={user._id} className="p-4 md:p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 hover:bg-slate-900/90 transition">
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-lg text-white">{user.nickname}</span>
                      <span className={`px-2.5 py-0.5 text-xs rounded-full font-medium uppercase ${
                        user.role === 'chief' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                      }`}>
                        {user.role}
                      </span>
                      <span className={`px-2.5 py-0.5 text-xs rounded-full font-medium uppercase ${
                        user.status === 'approved' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                      }`}>
                        {user.status}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    {user.status === 'pending' && (
                      <button
                        onClick={() => handleAction(user._id, 'approve')}
                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition"
                      >
                        Approve
                      </button>
                    )}
                    {user.role !== 'chief' && (
                      <button
                        onClick={() => handleAction(user._id, 'promote')}
                        className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold rounded-lg transition"
                      >
                        Promote to Chief
                      </button>
                    )}
                    <button
                      onClick={() => handleAction(user._id, 'remove')}
                      className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-semibold rounded-lg transition"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </main>
  );
}