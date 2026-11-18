'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Award, Check, Clock3, MailCheck, RefreshCw, Search, UserPlus, X } from 'lucide-react';
import { useSessionUser } from '@/components/AppShell';
import Dialog from '@/components/Dialog';
import LoadingSurface from '@/components/LoadingSurface';
import EmptyState from '@/components/EmptyState';
import { ApiError, clearClientData, readResponse } from '@/lib/client/api';
import { DG_PIECES, dgPuresNeeded, normalizedDgScore, type DgPiece } from '@/lib/dgGear';

type SetType = 'DG' | 'BDG';
type RequestRecord = { _id: string; status: 'requested' | 'pending-mail' | 'geared' | 'awarded' | 'cancelled'; requestedAt: string; requestedBy: string; requesterUserId?: string; recipientRowIndex?: number; recipientOwner?: string; recipientAccount?: string; mailedAt?: string; mailedBy?: string; excludedParts?: DgPiece[] };
type Toon = { rowIndex: number; owner: string; account: string; subClass: string; earned: number | null; fiveWeekActivity: number | null; dg: string; bdg: string; dgFunded: boolean; bdgFunded: boolean; requester: { id: string; nickname: string } | null; requesterToons: Array<{ rowIndex: number; owner: string; account: string }>; dgRequest: RequestRecord | null; bdgRequest: RequestRecord | null };
type Data = { toons: Toon[] };
type Winner = { rowIndex: number; owner: string; account: string; score: number; baseScore: number; requiredPures?: number; excludedParts?: DgPiece[]; requestedAt: string; requesterNickname: string; recipientToons: Array<{ rowIndex: number; owner: string; account: string }> };

function points(value: number | null) { return typeof value === 'number' ? value.toLocaleString() : '—'; }
function dateLabel(value: string | undefined) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'; }

export default function GearPage() {
  const user = useSessionUser();
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [setType, setSetType] = useState<SetType>('DG');
  const [winner, setWinner] = useState<Winner | null>(null);
  const [recipientSelections, setRecipientSelections] = useState<Record<string, string>>({});
  const [requestingRow, setRequestingRow] = useState<number | null>(null);
  const [excludedParts, setExcludedParts] = useState<DgPiece[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/gear', { cache: 'no-store', credentials: 'same-origin' });
      const result = await readResponse<Data>(response);
      setData(result); setError('');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { clearClientData(); router.replace('/login'); }
      else setError(cause instanceof Error ? cause.message : 'Gear requests could not be loaded.');
    }
  }, [router]);

  useEffect(() => { if (user) void load(); }, [user?.id, user?.role, load]);

  const act = async (action: 'request' | 'cancel' | 'reveal' | 'mailed', rowIndex?: number, recipientRowIndex?: number, excludedParts: DgPiece[] = []) => {
    const key = `${action}:${rowIndex ?? setType}`;
    if (busy) return;
    setBusy(key); setError(''); setNotice('');
    try {
      const response = await fetch('/api/admin/gear', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, setType, ...(rowIndex === undefined ? {} : { rowIndex }), ...(recipientRowIndex === undefined ? {} : { recipientRowIndex }), ...(action === 'request' && setType === 'DG' ? { excludedParts } : {}) }) });
      const result = await readResponse<{ message?: string; winner?: Winner }>(response);
      setNotice(result.message ?? '');
      if (action === 'reveal' && result.winner) { setWinner(result.winner); setRecipientSelections((current) => ({ ...current, [`${setType}:${result.winner!.rowIndex}`]: '' })); }
      if (action === 'request') { setRequestingRow(null); setExcludedParts([]); }
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { clearClientData(); router.replace('/login'); }
      else setError(cause instanceof Error ? cause.message : 'The gear action could not be completed.');
    } finally { setBusy(''); }
  };

  const statusField = setType === 'DG' ? 'dg' : 'bdg';
  const requestField = setType === 'DG' ? 'dgRequest' : 'bdgRequest';
  const scoreField = setType === 'DG' ? 'earned' : 'fiveWeekActivity';
  const rankingScore = (toon: Toon) => {
    const baseScore = toon[scoreField];
    return setType === 'DG' && typeof baseScore === 'number'
      ? normalizedDgScore(baseScore, toon.dgRequest?.excludedParts ?? [])
      : baseScore;
  };
  const visibleToons = (data?.toons ?? [])
    .filter((toon) => `${toon.owner} ${toon.account} ${toon.subClass}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (rankingScore(b) ?? -Infinity) - (rankingScore(a) ?? -Infinity) || a.owner.localeCompare(b.owner));

  const getRowDetails = (toon: Toon) => {
    const status = toon[statusField];
    const record = toon[requestField];
    const displayStatus = status === 'X' ? 'Geared' : 'Not geared';
    const requestStatus = record?.status === 'requested' ? 'Requested' : record?.status === 'pending-mail' ? 'Pending mail' : record?.status === 'cancelled' ? 'Cancelled' : record?.status === 'awarded' || record?.status === 'geared' ? 'Awarded' : '—';
    const selectionKey = `${setType}:${toon.rowIndex}`;
    const selectedRecipient = recipientSelections[selectionKey] ?? (record?.recipientRowIndex ? String(record.recipientRowIndex) : '');
    const recipientOptions = toon.requesterToons.filter((recipient) => data?.toons.find((candidate) => candidate.rowIndex === recipient.rowIndex)?.[statusField] !== 'X');
    return { status, record, displayStatus, requestStatus, selectedRecipient, selectionKey, recipientOptions };
  };

  const renderStatus = (displayStatus: string) => {
    const tone = displayStatus === 'Geared'
      ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200'
      : 'border-white/10 bg-white/[0.03] text-slate-400';
    return <span className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${tone}`}>{displayStatus === 'Geared' ? <Check size={12} /> : null}{displayStatus}</span>;
  };

  const renderRequestStatus = (requestStatus: string) => {
    const tone = requestStatus === 'Pending mail' ? 'text-amber-200' : requestStatus === 'Requested' ? 'text-indigo-200' : 'text-slate-500';
    return <span className={`inline-flex items-center gap-1.5 text-xs ${tone}`}>{requestStatus === 'Pending mail' ? <Clock3 size={12} /> : null}{requestStatus}</span>;
  };

  const renderAction = (toon: Toon, details: ReturnType<typeof getRowDetails>) => {
    const { record, selectedRecipient, selectionKey, recipientOptions } = details;
    const busyThis = busy.endsWith(`:${toon.rowIndex}`);
    if (record?.status === 'pending-mail') return <div className="flex min-w-56 items-center gap-2 max-lg:flex-col max-lg:items-stretch">
      <select className="min-h-10 min-w-36 rounded-lg border border-white/10 bg-slate-950 px-2 text-xs text-slate-200" aria-label={`Choose recipient toon for ${toon.account || toon.owner}`} value={selectedRecipient} onChange={(event) => setRecipientSelections((current) => ({ ...current, [selectionKey]: event.target.value }))}>
        <option value="">Choose recipient toon</option>
        {recipientOptions.map((recipient) => <option key={recipient.rowIndex} value={recipient.rowIndex}>{recipient.account || recipient.owner}</option>)}
      </select>
      <button type="button" className="secondary-button whitespace-nowrap" disabled={Boolean(busy) || !selectedRecipient} onClick={() => void act('mailed', toon.rowIndex, Number(selectedRecipient))}><MailCheck size={14} /> {busyThis ? 'Saving…' : 'Confirm mailed'}</button>
    </div>;
    if (record?.status === 'requested') return <button type="button" className="icon-button" aria-label={`Remove ${setType} request for ${toon.account || toon.owner}`} disabled={Boolean(busy)} onClick={() => void act('cancel', toon.rowIndex)} title="Remove request"><X size={16} /></button>;
    if (toon[setType === 'DG' ? 'dgFunded' : 'bdgFunded']) return <span className="text-xs text-slate-500">DKP already used for {setType}</span>;
    if (toon.requester && recipientOptions.length === 0) return <span className="text-xs text-slate-500">No eligible recipient toons</span>;
    if (toon.requester) return <button type="button" className="secondary-button whitespace-nowrap" disabled={Boolean(busy)} onClick={() => {
      if (setType === 'DG') { setExcludedParts([]); setRequestingRow(toon.rowIndex); }
      else void act('request', toon.rowIndex);
    }}><UserPlus size={14} /> {busyThis ? 'Saving…' : 'Add request'}</button>;
    return <span className="text-xs text-slate-500">No linked requester</span>;
  };

  if (!user) return <LoadingSurface fullLayout label="Checking leadership access" title="Gear requests" />;
  if (!['chief', 'general'].includes(user.role)) return <div className="mx-auto max-w-3xl py-16"><EmptyState title="Leadership access required" description="Gear tracking is available to Chiefs and Generals." /></div>;
  if (!data && !error) return <LoadingSurface fullLayout label="Loading gear tracking" title="Gear requests" />;
  const dgRequestToon = requestingRow === null ? null : data?.toons.find((toon) => toon.rowIndex === requestingRow) ?? null;
  const dgRequestPures = dgPuresNeeded(excludedParts);
  const dgRequestScore = typeof dgRequestToon?.earned === 'number' ? normalizedDgScore(dgRequestToon.earned, excludedParts) : null;

  return <div className="mx-auto max-w-6xl space-y-6">
    <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div><p className="page-kicker">Clan management</p><h1 className="page-title">Gear requests<span className="text-indigo-400">.</span></h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">Record Discord requests, reveal the next eligible winner, and confirm when the set has been mailed.</p></div>
      <button type="button" className="secondary-button self-start" onClick={() => void load()} disabled={Boolean(busy)}><RefreshCw size={15} /> Refresh</button>
    </header>

    {error && <p role="alert" className="rounded-xl border border-rose-400/20 bg-rose-400/5 px-4 py-3 text-sm text-rose-200">{error}</p>}
    {notice && <p role="status" className="rounded-xl border border-emerald-400/20 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-200">{notice}</p>}

    <section className="surface space-y-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2" role="tablist" aria-label="Gear type">
          {(['DG', 'BDG'] as const).map((type) => <button key={type} role="tab" aria-selected={setType === type} className={setType === type ? 'primary-button' : 'secondary-button'} onClick={() => { setSetType(type); setWinner(null); }}>{type}</button>)}
        </div>
        <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void act('reveal')}><Award size={16} /> {busy === `reveal:${setType}` ? 'Finding winner…' : `Reveal next ${setType} winner`}</button>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <p className="text-sm leading-6 text-slate-400">{setType === 'DG' ? 'DG requests use ceil(all-time DKP × 15 ÷ pures needed), accounting for excluded pieces. Equal adjusted scores go to the oldest request.' : 'Highest five-week activity wins. Equal scores go to the oldest request.'}</p>
        <label className="search-field sm:w-72"><Search /><input type="search" placeholder="Search toons…" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search toons" /></label>
      </div>

      {winner && <div className="rounded-2xl border border-indigo-300/25 bg-indigo-400/10 p-4" role="status"><div className="flex items-center gap-2 text-sm font-semibold text-indigo-100"><Award size={17} /> Next {setType} winner · pending mail</div><p className="mt-2 text-lg font-semibold text-white">{winner.account || winner.owner}</p><p className="mt-1 text-xs text-indigo-100/70">Requester {winner.requesterNickname} · DKP toon {winner.account || winner.owner} · {setType === 'DG' ? `Adjusted score ${points(winner.score)} from ${points(winner.baseScore)} DKP · ${winner.requiredPures ?? 15}/15 pures needed${winner.excludedParts?.length ? ` · excluded ${winner.excludedParts.map((key) => DG_PIECES.find((piece) => piece.key === key)?.label ?? key).join(', ')}` : ''}` : `Score ${points(winner.score)}`} · Requested {dateLabel(winner.requestedAt)}</p></div>}

      {!visibleToons.length ? <EmptyState title="No matching toons" description="Try another search or refresh the roster." /> : <>
        <div className="space-y-3 lg:hidden" aria-label="Gear roster">
          {visibleToons.map((toon) => {
            const details = getRowDetails(toon);
            return <article key={toon.rowIndex} className="rounded-xl border border-white/10 bg-slate-950/35 p-4">
              <header className="flex items-start justify-between gap-3">
                <div className="min-w-0"><h3 className="truncate text-sm font-semibold text-white">{toon.account || toon.owner}</h3><p className="mt-1 text-xs text-slate-500">{toon.subClass || 'Unassigned'}</p></div>
                {renderStatus(details.displayStatus)}
              </header>
              <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 border-t border-white/[0.07] pt-3 text-xs">
                <div><dt className="text-slate-500">Owner</dt><dd className="mt-1 break-words text-slate-200">{toon.owner}</dd></div>
                <div><dt className="text-slate-500">{setType === 'DG' ? 'All-time / adjusted DG' : '5-week activity'}</dt><dd className="mt-1 font-mono text-slate-200">{points(toon[scoreField])}{setType === 'DG' && details.record?.excludedParts?.length ? <span className="mt-1 block text-[10px] text-indigo-200">Adjusted {points(rankingScore(toon))} · {dgPuresNeeded(details.record.excludedParts)}/15 pures</span> : null}</dd></div>
                <div><dt className="text-slate-500">Request status</dt><dd className="mt-1">{renderRequestStatus(details.requestStatus)}{setType === 'DG' && details.record?.excludedParts?.length ? <span className="mt-1 block text-[10px] text-slate-400">Excluded {details.record.excludedParts.map((key) => DG_PIECES.find((piece) => piece.key === key)?.label ?? key).join(', ')}</span> : null}</dd></div>
                <div><dt className="text-slate-500">Requester</dt><dd className="mt-1 break-words text-slate-200">{toon.requester?.nickname ?? details.record?.requestedBy ?? '—'}</dd></div>
                <div><dt className="text-slate-500">Request date</dt><dd className="mt-1 text-slate-200">{details.record ? dateLabel(details.record.requestedAt) : '—'}</dd></div>
              </dl>
              <div className="mt-4 border-t border-white/[0.07] pt-3"><p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Action</p>{renderAction(toon, details)}</div>
            </article>;
          })}
        </div>
        <div className="hidden overflow-x-auto rounded-xl border border-white/10 lg:block">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-4 py-3">Toon</th><th className="px-4 py-3">Owner</th><th className="px-4 py-3">{setType === 'DG' ? 'All-time / adjusted DG' : '5-week activity'}</th><th className="px-4 py-3">Gear status</th><th className="px-4 py-3">Requester</th><th className="px-4 py-3">Action</th></tr></thead>
            <tbody className="divide-y divide-white/[0.06]">{visibleToons.map((toon) => {
              const details = getRowDetails(toon);
              return <tr key={toon.rowIndex}>
                <td className="px-4 py-3"><div className="font-medium text-white">{toon.account || toon.owner}</div><div className="mt-1 text-xs text-slate-500">{toon.subClass || 'Unassigned'}</div></td>
                <td className="px-4 py-3 text-slate-300">{toon.owner}</td>
                <td className="px-4 py-3 font-mono text-slate-200">{points(toon[scoreField])}{setType === 'DG' && details.record?.excludedParts?.length ? <span className="mt-1 block text-[10px] text-indigo-200">Adjusted {points(rankingScore(toon))} · {dgPuresNeeded(details.record.excludedParts)}/15 pures</span> : null}</td>
                <td className="px-4 py-3"><div className="space-y-1">{renderStatus(details.displayStatus)}{details.requestStatus !== '—' && renderRequestStatus(details.requestStatus)}</div>{setType === 'DG' && details.record?.excludedParts?.length ? <div className="mt-1 text-[11px] text-slate-400">Excluded {details.record.excludedParts.map((key) => DG_PIECES.find((piece) => piece.key === key)?.label ?? key).join(', ')}</div> : null}{details.record && <div className="mt-1 text-[11px] text-slate-500">Requested {dateLabel(details.record.requestedAt)}</div>}</td>
                <td className="px-4 py-3 text-xs text-slate-400">{toon.requester?.nickname ?? details.record?.requestedBy ?? '—'}</td>
                <td className="px-4 py-3">{renderAction(toon, details)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      </>}
    </section>
    {requestingRow !== null && dgRequestToon && <Dialog labelledBy="dg-excluded-pieces-title" busy={Boolean(busy)} onClose={() => { setRequestingRow(null); setExcludedParts([]); }}>
      <div className="relative overflow-hidden border-b border-slate-800 bg-gradient-to-r from-indigo-950/80 via-slate-900 to-violet-950/80 px-5 py-5 sm:px-7">
        <div className="pointer-events-none absolute -right-8 -top-16 h-48 w-48 rounded-full bg-indigo-400/10 blur-3xl" />
        <p className="relative text-[10px] font-bold uppercase tracking-[.2em] text-indigo-300">DG request details</p>
        <h2 id="dg-excluded-pieces-title" className="relative mt-1 text-xl font-black text-white">Which pieces are excluded?</h2>
        <p className="relative mt-1 text-sm text-slate-400">{dgRequestToon.account || dgRequestToon.owner} · select pieces they already have.</p>
      </div>
      <div className="space-y-5 p-5 sm:p-7">
        <div className="grid gap-2 sm:grid-cols-2">
          {DG_PIECES.map((piece) => {
            const selected = excludedParts.includes(piece.key);
            const wouldLeaveNoPieces = !selected && dgRequestPures <= piece.pures;
            return <button key={piece.key} type="button" aria-pressed={selected} disabled={Boolean(busy) || wouldLeaveNoPieces} onClick={() => setExcludedParts((current) => current.includes(piece.key) ? current.filter((part) => part !== piece.key) : [...current, piece.key])} className={`flex min-h-14 items-center justify-between rounded-xl border px-4 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${selected ? 'border-indigo-300/50 bg-indigo-400/10 text-white' : 'border-white/10 bg-slate-950/40 text-slate-300 hover:border-white/20'}`}>
              <span><span className="block text-sm font-semibold">{piece.label}</span><span className="mt-0.5 block text-[10px] text-slate-500">{piece.pures} {piece.pures === 1 ? 'pure' : 'pures'}</span></span>
              <span className={`flex h-5 w-5 items-center justify-center rounded-md border text-xs ${selected ? 'border-indigo-300 bg-indigo-400 text-slate-950' : 'border-slate-600'}`}>{selected ? '✓' : ''}</span>
            </button>;
          })}
        </div>
        <div className="rounded-xl border border-emerald-300/20 bg-emerald-300/[.05] p-4">
          <div className="flex items-end justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Pures needed</p><p className="mt-1 text-2xl font-black text-white">{dgRequestPures}<span className="ml-1 text-sm font-semibold text-slate-500">/ 15</span></p></div><div className="text-right"><p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Adjusted DG score</p><p className="mt-1 text-2xl font-black text-emerald-300">{dgRequestScore === null ? '—' : points(dgRequestScore)}</p></div></div>
          <p className="mt-2 text-[11px] leading-5 text-slate-400">Ceiling of {points(dgRequestToon.earned)} DKP × 15 ÷ {dgRequestPures} pures. No exclusions means the full 15-pure set.</p>
        </div>
        {error && <p role="alert" className="rounded-xl border border-rose-400/20 bg-rose-400/5 p-3 text-sm text-rose-200">{error}</p>}
        <div className="flex flex-col-reverse justify-end gap-2 sm:flex-row">
          <button type="button" className="secondary-button justify-center" disabled={Boolean(busy)} onClick={() => { setRequestingRow(null); setExcludedParts([]); }}>Cancel</button>
          <button type="button" className="primary-button justify-center" disabled={Boolean(busy) || dgRequestPures < 1} onClick={() => void act('request', requestingRow, undefined, excludedParts)}><UserPlus size={15} /> {busy === `request:${requestingRow}` ? 'Saving…' : 'Add DG request'}</button>
        </div>
      </div>
    </Dialog>}
  </div>;
}
