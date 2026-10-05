'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, History, LoaderCircle, Save, Shield, Users, X } from 'lucide-react';

interface RosterMember {
  rowIndex: number;
  owner: string;
  account: string;
}

interface BossAward {
  id: string;
  bossName: string;
  points: number;
  participants: RosterMember[];
  createdBy: string;
  updatedBy?: string;
  status: 'pending' | 'applied' | 'failed' | 'updating';
  failureReason?: string;
  createdAt: string;
}

export default function BossHistoryPage() {
  const [awards, setAwards] = useState<BossAward[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [selectedRows, setSelectedRows] = useState<Record<string, number[]>>({});
  const [editingId, setEditingId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [accessDenied, setAccessDenied] = useState(false);
  const router = useRouter();

  const loadHistory = async () => {
    try {
      const response = await fetch('/api/admin/boss-history');
      const data = await response.json();
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      if (response.status === 403) {
        setAccessDenied(true);
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Unable to load boss history');
      setAwards(data.awards);
      setRoster(data.roster);
      setSelectedRows(Object.fromEntries(
        data.awards.map((award: BossAward) => [
          award.id,
          award.participants.map((participant) => participant.rowIndex),
        ]),
      ));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load boss history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadHistory();
  }, []);

  const toggleRow = (awardId: string, rowIndex: number) => {
    setSelectedRows((current) => {
      const rows = current[awardId] ?? [];
      return {
        ...current,
        [awardId]: rows.includes(rowIndex)
          ? rows.filter((selected) => selected !== rowIndex)
          : [...rows, rowIndex],
      };
    });
  };

  const saveAttendance = async (awardId: string) => {
    setBusyId(awardId);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/admin/boss-history', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ awardId, selectedRows: selectedRows[awardId] ?? [] }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to update boss attendance');
      setNotice(data.message);
      setEditingId('');
      await loadHistory();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to update boss attendance');
    } finally {
      setBusyId('');
    }
  };

  if (loading) {
    return <div className="min-h-screen bg-[#07090e] p-8 text-sm text-slate-400">Loading boss history...</div>;
  }

  if (accessDenied) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#07090e] px-5 text-slate-100">
        <section className="w-full max-w-md border-y border-slate-800 py-8 text-center">
          <Shield className="mx-auto h-8 w-8 text-amber-300" />
          <h1 className="mt-4 text-lg font-bold text-white">Chief or General access required</h1>
          <button onClick={() => router.push('/dashboard')} className="mt-5 rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">
            Back to dashboard
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#07090e] text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-slate-950/90 px-5 py-4 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
              <History className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-bold text-white">Boss history</h1>
              <p className="text-xs text-slate-400">Review awards and correct toon attendance</p>
            </div>
          </div>
          <button onClick={() => router.push('/admin/requests')} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800">
            <ArrowLeft className="h-4 w-4" /> Clan administration
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-4 px-5 py-6 sm:px-8">
        <p className="text-sm text-slate-400">
          Editing an award adds or removes its points from Weekly Earned, All-time Earned, and Available for changed toons.
        </p>
        {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}
        {notice && <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>}

        {awards.length === 0 ? (
          <section className="border-y border-slate-800 py-12 text-center">
            <History className="mx-auto h-7 w-7 text-slate-600" />
            <p className="mt-3 text-sm text-slate-400">No boss awards have been logged yet.</p>
          </section>
        ) : awards.map((award) => {
          const isEditing = editingId === award.id;
          const selectedCount = selectedRows[award.id]?.length ?? 0;
          return (
            <article key={award.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 sm:p-5">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-bold text-white">{award.bossName}</h2>
                    <span className="rounded-full bg-indigo-500/10 px-2.5 py-1 text-xs font-semibold text-indigo-300">
                      +{award.points} DKP
                    </span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${award.status === 'applied' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}>
                      {award.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {new Date(award.createdAt).toLocaleString()} · Recorded by {award.createdBy}
                    {award.updatedBy ? ` · Last edited by ${award.updatedBy}` : ''}
                  </p>
                </div>
                {award.status === 'applied' && !isEditing && (
                  <button
                    onClick={() => setEditingId(award.id)}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-indigo-500/40 px-3 py-2 text-sm font-semibold text-indigo-200 hover:bg-indigo-500/10"
                  >
                    <Users className="h-4 w-4" /> Edit toons
                  </button>
                )}
              </div>

              {award.status !== 'applied' && award.failureReason && (
                <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{award.failureReason}</p>
              )}

              {isEditing ? (
                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
                    <span>Select who should receive this boss award; clear all to reverse it for everyone.</span>
                    <span>{selectedCount} selected</span>
                  </div>
                  <div className="grid max-h-72 grid-cols-1 gap-x-3 overflow-y-auto rounded-lg border border-slate-800 p-2 sm:grid-cols-2">
                    {roster.map((record) => (
                      <label key={record.rowIndex} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
                        <input
                          type="checkbox"
                          checked={(selectedRows[award.id] ?? []).includes(record.rowIndex)}
                          onChange={() => toggleRow(award.id, record.rowIndex)}
                          className="h-4 w-4 accent-indigo-500"
                        />
                        <span className="min-w-0 truncate">{record.owner} · {record.account || 'Unnamed toon'}</span>
                      </label>
                    ))}
                    {roster.length === 0 && <p className="px-2 py-3 text-sm text-slate-500">No roster records found.</p>}
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      onClick={() => {
                        setSelectedRows((current) => ({
                          ...current,
                          [award.id]: award.participants.map((participant) => participant.rowIndex),
                        }));
                        setEditingId('');
                      }}
                      disabled={busyId === award.id}
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      <X className="h-4 w-4" /> Cancel
                    </button>
                    <button
                      onClick={() => void saveAttendance(award.id)}
                      disabled={busyId === award.id}
                      className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {busyId === award.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      Save changes
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-4 border-t border-slate-800 pt-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Participants · {award.participants.length}
                  </p>
                  {award.participants.length === 0 ? (
                    <p className="mt-2 text-sm text-slate-500">No toons currently receive this award.</p>
                  ) : (
                    <p className="mt-2 text-sm text-slate-300">
                      {award.participants.map((participant) => participant.account || participant.owner).join(', ')}
                    </p>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </main>
  );
}
