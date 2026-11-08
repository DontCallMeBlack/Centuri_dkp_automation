'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Dialog from '@/components/Dialog';
import AuctionItemImage from '@/components/AuctionItemImage';
import AuctionPostingPanel from '@/components/AuctionPostingPanel';
import type { AuctionCatalogItem } from '@/components/AuctionItemCreateForm';
import { CalendarClock, Check, ChevronDown, ChevronUp, Clock3, Filter, Gavel, LoaderCircle, PackageCheck, Plus, RefreshCw, Search, ShieldAlert, Trophy, X } from 'lucide-react';
import LoadingSurface from '@/components/LoadingSurface';
import EmptyState from '@/components/EmptyState';
import RoleBadge from '@/components/RoleBadge';
import RosterDataIssues from '@/components/RosterDataIssues';
import type { DkpCellIssue } from '@/lib/sheetRoster';
import { ApiError, getData, clientDataVersion, peekData, rememberData, clearClientData, notifyDkpChanged } from '@/lib/client/api';
import { normalizeAuctionRole, canRoleBid } from '@/lib/auctionRules';
import { ROLE_CHANGE_TIME_ZONE } from '@/lib/toonRoleChanges';
import { useSessionUser } from '@/components/AppShell';
import { getActionRequestId, completeActionRequest } from '@/lib/client/actionRequests';
import { auctionPollPlan } from '@/lib/client/auctionPolling';
import { auctionBalanceChanged, readAuctionLiveUpdates } from '@/lib/client/auctionLiveUpdates';

interface AuctionToon {
  rowIndex: number;
  owner: string;
  account: string;
  subClass: string;
  weeklyEarned: number;
  available: number | null;
  heldPoints: number;
  canBid?: boolean;
  roleChange?: { scheduledRole: string; effectiveAt: string } | null;
}

interface CatalogItem {
  id: string;
  name: string;
  requiredRoles: string[];
  requiredRole?: string;
  bossType: string;
  imageCount: number;
}

interface AuctionBid {
  isMine: boolean;
  nickname: string;
  rowIndex: number;
  owner: string;
  account: string;
  amount: number;
  placedAt: string;
}

interface Auction {
  id: string;
  itemId: string;
  imageCount: number;
  itemName: string;
  bossType: string;
  requiredRoles: string[];
  requiredRole?: string;
  createdBy: string;
  isPoster: boolean;
  isWinner: boolean;
  canMarkDelivered: boolean;
  canRemove: boolean;
  createdAt: string;
  endsAt: string;
  biddingClosed: boolean;
  bidVersion?: number;
  versionToken?: string;
  status: 'active' | 'settling' | 'completed' | 'settlement-failed';
  highBid: AuctionBid | null;
  winner: AuctionBid | null;
  deliveryStatus: 'pending' | 'done' | 'not-required' | 'banked' | 'reposted';
  deliveredBy: string | null;
  deliveredAt: string | null;
  settlementError: string | null;
  canResolveNoBid: boolean;
  canRetrySettlement?: boolean;
}

interface AuctionHistory { auctions: Auction[]; nextCursor?: string | null }

function mailedItemSummary(auction: Auction) {
  return `${auction.deliveredBy || 'A leader'} mailed ${auction.itemName} to ${auction.winner?.account || auction.winner?.owner || 'the winning toon'}`;
}

interface AuctionData {
  nextCursor?: string | null;
  dkpIssues?: DkpCellIssue[];
  manager: boolean;
  weeklyEarnedTotal: number;
  weeklyMinimum: number;
  canBidWeekly: boolean;
  roles: string[];
  toons: AuctionToon[];
  items: CatalogItem[];
  auctions: Auction[];
  rosterSync: {
    fetchedAt: string;
    stale: boolean;
    refreshDelayed: boolean;
  };
}

const AUCTION_PREVIEW_CACHE_KEY = '/ui/auction-preview';
function rememberAuctionData(data: AuctionData) {
  const preview: AuctionData = {
    ...data,
    manager: false,
    weeklyEarnedTotal: 0,
    canBidWeekly: false,
    roles: [],
    toons: [],
    auctions: data.auctions.map((auction) => ({
      ...auction,
      isPoster: false,
      isWinner: false,
      canMarkDelivered: false,
      canRemove: false,
      canResolveNoBid: false,
      canRetrySettlement: false,
      highBid: auction.highBid ? { ...auction.highBid, isMine: false } : null,
      winner: auction.winner ? { ...auction.winner, isMine: false } : null,
    })),
  };
  rememberData(AUCTION_PREVIEW_CACHE_KEY, preview);
}

function readAuctionCache() {
  return peekData<AuctionData>('/api/auction') ?? peekData<AuctionData>(AUCTION_PREVIEW_CACHE_KEY);
}

const roleStyles: Record<string, string> = {
  ranger: 'border-yellow-400/30 bg-yellow-400/10 text-yellow-300',
  'dps rogue': 'border-violet-400/30 bg-violet-400/10 text-violet-300',
  'fire mage': 'border-orange-700/40 bg-orange-800/20 text-orange-300',
  'ice mage': 'border-sky-300/30 bg-sky-300/10 text-sky-200',
  'support druid': 'border-green-400/30 bg-green-400/10 text-green-300',
  'dps druid': 'border-purple-800/50 bg-purple-900/30 text-purple-300',
  'support rogue': 'border-fuchsia-400/35 bg-fuchsia-400/10 text-fuchsia-400',
  'dps warrior': 'border-red-400/30 bg-red-400/10 text-red-300',
  tank: 'border-pink-400/30 bg-pink-400/10 text-pink-300',
};

function formatRemaining(endsAt: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(endsAt).getTime() - now) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours === 0) return `${minutes}m ${remainingSeconds}s`;
  return `${hours}h ${minutes}m`;
}

let clockValue = 0;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
const clockListeners = new Set<() => void>();
const readClock = () => clockValue;
const serverClock = () => 0;
function subscribeClock(listener: () => void) {
  clockValue = Date.now();
  clockListeners.add(listener);
  countdownTimer ??= setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    clockValue = Date.now();
    for (const notify of clockListeners) notify();
  }, 1000);
  return () => {
    clockListeners.delete(listener);
    if (!clockListeners.size) { clearInterval(countdownTimer); countdownTimer = undefined; }
  };
}

function AuctionCountdown({ endsAt }: { endsAt: string }) {
  const now = useSyncExternalStore(subscribeClock, readClock, serverClock);
  const endingSoon = now > 0 && new Date(endsAt).getTime() - now <= 30_000;
  return <span className={`auction-countdown inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-xs font-bold tabular-nums ${endingSoon ? 'animate-pulse border-rose-300/30 bg-rose-950/35 text-rose-200' : 'border-slate-700 bg-slate-950/60 text-slate-200'}`}><Clock3 className="h-3 w-3" />{now ? formatRemaining(endsAt, now) : '…'}</span>;
}

export default function AuctionHousePanel({ active = true }: { active?: boolean }) {
  const sessionUser = useSessionUser();
  const activeRef = useRef(active);
  activeRef.current = active;
  const initialAuctionData = readAuctionCache();
  const [data, setData] = useState<AuctionData | null>(() => initialAuctionData);
  const dataRef = useRef<AuctionData | null>(data);
  const fullRefreshCount = useRef(0);
  const liveEpoch = useRef(0);
  const lastDiscoveryAt = useRef(Date.now());
  const lastTargetAt = useRef(0);
  const checkedAuctionWindows = useRef(new Set<string>());
  const initialRefreshStarted = useRef(false);
  const refreshRef = useRef<(maxAgeMs?: number) => Promise<unknown>>(async () => undefined);
  const [loading, setLoading] = useState(() => !initialAuctionData);
  const [syncing, setSyncing] = useState(() => Boolean(initialAuctionData));
  const [lastSyncedAt, setLastSyncedAt] = useState<number>(0);
  const [localTimeReady, setLocalTimeReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now());
  const [postFormOpen, setPostFormOpen] = useState(false);
  const [todoListOpen, setTodoListOpen] = useState(false);
  const [wonItemsOpen, setWonItemsOpen] = useState(false);
  const [wonHistory, setWonHistory] = useState<Auction[]>([]);
  const [wonCursor, setWonCursor] = useState<string | null>(null);
  const [wonLoading, setWonLoading] = useState(false);
  const [wonLoaded, setWonLoaded] = useState(false);
  const wonSequence = useRef(0);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [auctionRoleFilter, setAuctionRoleFilter] = useState('');
  const [auctionBossFilter, setAuctionBossFilter] = useState('');
  const [auctionHolderFilter, setAuctionHolderFilter] = useState('');
  const [auctionSearch, setAuctionSearch] = useState('');
  const [auctionFiltersOpen, setAuctionFiltersOpen] = useState(false);
  const [archiveAuctions, setArchiveAuctions] = useState<Auction[]>([]);
  const [archiveLoaded, setArchiveLoaded] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveCursor, setArchiveCursor] = useState<string | null>(null);
  const archiveLoadedRef = useRef(false);
  const archiveSequence = useRef(0);
  const [selectedToons, setSelectedToons] = useState<Record<string, number>>({});
  const [bidAmounts, setBidAmounts] = useState<Record<string, string>>({});
  const [auctionView, setAuctionView] = useState<'live' | 'all'>('live');
  const router = useRouter();

  useEffect(() => {
    if (!active) setPostFormOpen(false);
  }, [active]);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    setLocalTimeReady(true);
  }, []);

  useEffect(() => {
    if (!active || auctionView !== 'live') return;
    let mounted = true;
    let pollInFlight = false;
    let refreshTimer: number | undefined;
    const pollLiveAuctions = async () => {
      const current = dataRef.current;
      if (!current || pollInFlight || fullRefreshCount.current > 0 || !activeRef.current || document.visibilityState !== 'visible' || navigator.onLine === false) return;
      pollInFlight = true;
      const pollGeneration = clientDataVersion();
      const epoch = liveEpoch.current;
      try {
        const plan = auctionPollPlan(current, Date.now(), lastDiscoveryAt.current, lastTargetAt.current, checkedAuctionWindows.current);
        if (plan.eligibilityWindows.length) {
          for (const key of plan.eligibilityWindows) checkedAuctionWindows.current.add(key);
          await refreshRef.current();
          lastTargetAt.current = Date.now();
          return;
        }
        if (!plan.discover && !plan.ids.length) return;
        const scopedAuctions = plan.discover ? current.auctions : current.auctions.filter((auction) => plan.ids.includes(auction.id));
        if (plan.discover) lastDiscoveryAt.current = Date.now();
        lastTargetAt.current = Date.now();
        const result = await readAuctionLiveUpdates(scopedAuctions, plan.discover);
        if (!mounted || pollGeneration !== clientDataVersion() || epoch !== liveEpoch.current) return;
        setError('');
        setLastSyncedAt(Date.now());
        if (!result.changed || !Array.isArray(result.auctions)) return;
        const personalBalanceChanged = auctionBalanceChanged(current.auctions, result.auctions, result.removedIds);
        const byId = new Map((result.auctions as Auction[]).map((auction) => [auction.id, auction]));
        setData((previous) => {
          if (!previous) return previous;
          const updated = {
            ...previous,
            auctions: previous.auctions.filter((auction) => !(result.removedIds as string[] | undefined)?.includes(auction.id)).map((auction) => {
              const live = byId.get(auction.id);
              return live ? { ...auction, ...live } : auction;
            }).concat((result.auctions as Auction[]).filter((live) => !previous.auctions.some((auction) => auction.id === live.id)))
              .filter((auction) => auction.status !== 'completed' || auction.deliveryStatus === 'pending' || auction.canResolveNoBid)
              .sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime()),
          };
          dataRef.current = updated;
          rememberAuctionData(updated);
          return updated;
        });
        setArchiveAuctions((previous) => previous
          .filter((auction) => !(result.removedIds as string[] | undefined)?.includes(auction.id))
          .map((auction) => byId.has(auction.id) ? { ...auction, ...byId.get(auction.id)! } : auction));
        setWonHistory((previous) => previous
          .filter((auction) => !(result.removedIds as string[] | undefined)?.includes(auction.id))
          .map((auction) => byId.has(auction.id) ? { ...auction, ...byId.get(auction.id)! } : auction));
        setLastSyncedAt(Date.now());
        if (personalBalanceChanged) await refreshRef.current();
      } catch (cause) {
        if (mounted) setError(cause instanceof Error ? cause.message : 'Live updates are delayed. Retrying automatically.');
      } finally {
        pollInFlight = false;
      }
    };
    const schedulePoll = () => {
      if (!mounted || !activeRef.current) return;
      window.clearTimeout(refreshTimer);
      const current = dataRef.current;
      if (!current) return;
      const plan = auctionPollPlan(current, Date.now(), lastDiscoveryAt.current, lastTargetAt.current, checkedAuctionWindows.current);
      const delay = document.visibilityState !== 'visible' || navigator.onLine === false ? 60_000 : plan.delay;
      refreshTimer = window.setTimeout(() => {
        void pollLiveAuctions().finally(schedulePoll);
      }, delay);
    };
    // The local timer wakes at the final-five-minute boundary without a server call.
    const wake = () => schedulePoll();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    schedulePoll();
    return () => {
      mounted = false;
      window.clearTimeout(refreshTimer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [active, auctionView, data?.auctions, data?.toons, data?.canBidWeekly]);

  // Re-render the auction list at expiry; only countdown text updates each second.
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const nextEnd = Math.min(...(data?.auctions ?? [])
      .filter((auction) => auction.status === 'active' && !auction.biddingClosed)
      .map((auction) => new Date(auction.endsAt).getTime())
      .filter((end) => end > now));
    const timer = Number.isFinite(nextEnd)
      ? window.setTimeout(tick, Math.min(2_147_483_647, Math.max(0, nextEnd - Date.now()))) : undefined;
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', tick); };
  }, [active, data?.auctions, now]);

  const refresh = async (maxAgeMs = 0) => {
    fullRefreshCount.current += 1; liveEpoch.current += 1;
    setSyncing(true);
    const version = clientDataVersion();
    try {
      const result = await getData<AuctionData>('/api/auction', { maxAgeMs });
      if (version !== clientDataVersion()) return;
      setError('');
      dataRef.current = result;
      lastDiscoveryAt.current = Date.now();
      setData(result);
      rememberAuctionData(result);
      setLastSyncedAt(Date.now());
      setSyncing(false);
      if (auctionView === 'all' && archiveLoadedRef.current) await loadFullAuctionHistory();
      if (wonItemsOpen && wonLoaded) await loadWonHistory();
    } catch (refreshError) {
      setSyncing(false);
      if (refreshError instanceof ApiError && refreshError.status === 401) { clearClientData(); router.replace('/login'); return false; }
      throw refreshError;
    } finally {
      fullRefreshCount.current = Math.max(0, fullRefreshCount.current - 1);
      if (version === clientDataVersion()) setLoading(false);
    }
  };
  refreshRef.current = refresh;
  useEffect(() => {
    if (!active || initialRefreshStarted.current) return;
    initialRefreshStarted.current = true;
    void refreshRef.current(15_000).catch((cause) => setError(cause instanceof Error ? cause.message : 'Auction updates are delayed.'));
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const refreshAfterLocalChange = () => {
      initialRefreshStarted.current = true;
      void refreshRef.current().catch((cause) => setError(cause instanceof Error ? cause.message : 'Auction updates are delayed.'));
    };
    window.addEventListener('centuri:dkp-changed', refreshAfterLocalChange);
    window.addEventListener('centuri:catalog-changed', refreshAfterLocalChange);
    return () => {
      window.removeEventListener('centuri:dkp-changed', refreshAfterLocalChange);
      window.removeEventListener('centuri:catalog-changed', refreshAfterLocalChange);
    };
  }, [active]);

  const updateAuctionInView = (auctionId: string, changes: Partial<Auction>) => {
    setData((current) => {
      if (!current) return current;
      const updated = { ...current, auctions: current.auctions.map((auction) => auction.id === auctionId ? { ...auction, ...changes } : auction) };
      dataRef.current = updated;
      rememberAuctionData(updated);
      return updated;
    });
    setArchiveAuctions((current) => current.map((auction) => auction.id === auctionId ? { ...auction, ...changes } : auction));
  };

  const addAuctionToView = (auction: Auction) => {
    setData((current) => {
      if (!current || current.auctions.some((entry) => entry.id === auction.id)) return current;
      const updated = { ...current, auctions: [auction, ...current.auctions] };
      dataRef.current = updated;
      rememberAuctionData(updated);
      return updated;
    });
  };

  const removeAuctionFromView = (auctionId: string) => {
    setData((current) => {
      if (!current) return current;
      const updated = { ...current, auctions: current.auctions.filter((auction) => auction.id !== auctionId) };
      dataRef.current = updated;
      rememberAuctionData(updated);
      return updated;
    });
    setArchiveAuctions((current) => current.filter((auction) => auction.id !== auctionId));
  };

  const refreshInBackground = (confirmedAction: string) => {
    void refresh().catch((cause) => setError(`${confirmedAction} The latest auction view is delayed: ${cause instanceof Error ? cause.message : 'retrying automatically.'}`));
  };

  useEffect(() => {
    const clear = () => { checkedAuctionWindows.current.clear(); lastTargetAt.current = 0; lastDiscoveryAt.current = Date.now(); wonSequence.current += 1; setWonHistory([]); setWonCursor(null); setWonLoading(false); setWonLoaded(false); setWonItemsOpen(false); initialRefreshStarted.current = false; archiveSequence.current += 1; archiveLoadedRef.current = false; setArchiveCursor(null); setArchiveLoading(false); setData(null); dataRef.current = null; setArchiveAuctions([]); setArchiveLoaded(false); setAuctionView('live'); setSelectedToons({}); setBidAmounts({}); setLastSyncedAt(0); setLoading(true); setSyncing(false); setPostFormOpen(false); setSelectedItemId(''); setError(''); setNotice(''); };
    window.addEventListener('centuri:clear-data', clear);
    return () => window.removeEventListener('centuri:clear-data', clear);
  }, []);

  const loadFullAuctionHistory = async (append = false) => {
    if (append && (!archiveCursor || archiveLoading)) return;
    const version = clientDataVersion();
    const sequence = ++archiveSequence.current;
    setArchiveLoading(true);
    setError('');
    try {
      const suffix = append && archiveCursor ? `&cursor=${encodeURIComponent(archiveCursor)}` : '';
      const result = await getData<AuctionHistory>(`/api/auction?includeArchive=1${suffix}`);
      if (version !== clientDataVersion() || sequence !== archiveSequence.current) return;
      setArchiveCursor(result.nextCursor ?? null);
      setArchiveAuctions((previous) => [...new Map([...(append ? previous : []), ...result.auctions].map((auction) => [auction.id, auction])).values()]);
      archiveLoadedRef.current = true;
      setArchiveLoaded(true);
    } catch (historyError) {
      if (version === clientDataVersion() && sequence === archiveSequence.current) setError(historyError instanceof Error ? historyError.message : 'Unable to load full auction history');
    } finally {
      if (version === clientDataVersion() && sequence === archiveSequence.current) setArchiveLoading(false);
    }
  };

  useEffect(() => {
    if (auctionView === 'all' && !archiveLoadedRef.current && !archiveLoading) {
      void loadFullAuctionHistory();
    }
  }, [auctionView]);

  const loadWonHistory = async (append = false) => {
    if (append && (!wonCursor || wonLoading)) return;
    const version = clientDataVersion();
    const sequence = ++wonSequence.current;
    setWonLoading(true);
    try {
      const suffix = append && wonCursor ? `&cursor=${encodeURIComponent(wonCursor)}` : '';
      const result = await getData<AuctionHistory>(`/api/auction?includeArchive=1&won=1${suffix}`);
      if (version !== clientDataVersion() || sequence !== wonSequence.current) return;
      setWonHistory((previous) => [...new Map([...(append ? previous : []), ...result.auctions].map((auction) => [auction.id, auction])).values()]);
      setWonCursor(result.nextCursor ?? null);
      setWonLoaded(true);
    } catch (cause) {
      if (version === clientDataVersion() && sequence === wonSequence.current) setError(cause instanceof Error ? cause.message : 'Unable to load your wins.');
    } finally {
      if (version === clientDataVersion() && sequence === wonSequence.current) setWonLoading(false);
    }
  };

  const submitAuction = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('Posting auction…');
    try {
      if (!sessionUser?.id) throw new Error('Your session is still loading. Try again in a moment.');
      const requestId = await getActionRequestId(sessionUser.id, 'auction-create', selectedItemId);
      const response = await fetch('/api/auction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create-auction', itemId: selectedItemId, requestId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to post auction');
      await completeActionRequest(sessionUser.id, 'auction-create', selectedItemId);
      const item = dataRef.current?.items.find((entry) => entry.id === selectedItemId);
      if (item && typeof result.auctionId === 'string') {
        const createdAt = new Date();
        addAuctionToView({
          id: result.auctionId,
          itemId: item.id,
          imageCount: item.imageCount,
          itemName: item.name,
          bossType: item.bossType,
          requiredRoles: item.requiredRoles,
          requiredRole: item.requiredRoles[0],
          createdBy: sessionUser.nickname,
          isPoster: true,
          isWinner: false,
          canMarkDelivered: false,
          canRemove: true,
          createdAt: createdAt.toISOString(),
          endsAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
          biddingClosed: false,
          status: 'active',
          highBid: null,
          winner: null,
          deliveryStatus: 'not-required',
          deliveredBy: null,
          deliveredAt: null,
          settlementError: null,
          canResolveNoBid: false,
        });
      }
      setAuctionView('live');
      setSelectedItemId('');
      setNotice('Auction posted for 24 hours. Bids in the final 5 minutes leave 5 minutes on the clock.');
      setPostFormOpen(false);
      refreshInBackground('Auction posted.');
    } catch (submitError) {
      setNotice('');
      setError(submitError instanceof Error ? submitError.message : 'Unable to post auction');
    } finally {
      setSaving(false);
    }
  };

  const submitBid = async (auction: Auction) => {
    const auctionRoles = auction.requiredRoles?.length ? auction.requiredRoles : [auction.requiredRole ?? ''];
    const eligibleToons = data?.toons.filter((toon) =>
      canRoleBid(toon.subClass, auctionRoles),
    ) ?? [];
    const rowIndex = selectedToons[auction.id] ?? eligibleToons[0]?.rowIndex;
    const rawAmount = bidAmounts[auction.id]?.trim() ?? '';
    const amount = /^\d+$/.test(rawAmount) ? Number(rawAmount) : NaN;
    if (!Number.isInteger(rowIndex) || !Number.isSafeInteger(amount) || amount <= 0) {
      setError('Choose an eligible toon and enter a positive whole-number bid.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('Submitting bid… current bids and balance are being checked.');
    try {
      const response = await fetch('/api/auction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bid', auctionId: auction.id, rowIndex, amount }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to place bid');
      setNotice(result.message);
      notifyDkpChanged();
      if (result.highBid) updateAuctionInView(auction.id, { highBid: result.highBid as AuctionBid, endsAt: result.endsAt ?? auction.endsAt });
      setBidAmounts((current) => ({ ...current, [auction.id]: '' }));
      refreshInBackground('Bid placed.');
    } catch (bidError) {
      setNotice('');
      const failure = bidError instanceof Error ? bidError.message : 'Unable to confirm bid';
      try { await refresh(); setError(failure); }
      catch { setError(`${failure} Current bids could not be refreshed; the displayed balances may have changed.`); }
    } finally {
      setSaving(false);
    }
  };

  const markDelivered = async (auction: Auction) => {
    setSaving(true);
    setError('');
    setNotice('Saving delivery update…');
    try {
      const response = await fetch('/api/auction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark-delivered', auctionId: auction.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to update delivery task');
      const delivery = { deliveryStatus: 'done' as const, deliveredBy: sessionUser?.nickname ?? null, deliveredAt: new Date().toISOString(), canMarkDelivered: false };
      const message = mailedItemSummary({ ...auction, ...delivery });
      setNotice(message);
      updateAuctionInView(auction.id, delivery);
      refreshInBackground(message);
    } catch (deliveryError) {
      setNotice('');
      setError(deliveryError instanceof Error ? deliveryError.message : 'Unable to update delivery task');
    } finally {
      setSaving(false);
    }
  };

  const removeAuction = async (auction: Auction) => {
    if (!window.confirm(
      `Remove the auction for ${auction.itemName}? Any leading bid will be released. Ended auctions remain in the history.`,
    )) return;

    setSaving(true);
    setError('');
    setNotice('Removing auction…');
    try {
      const response = await fetch('/api/auction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove-auction', auctionId: auction.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to remove auction');
      setNotice(result.message);
      removeAuctionFromView(auction.id);
      refreshInBackground('Auction removed.');
    } catch (removeError) {
      setNotice('');
      setError(removeError instanceof Error ? removeError.message : 'Unable to remove auction');
    } finally {
      setSaving(false);
    }
  };

  const resolveNoBidAuction = async (auction: Auction, resolution: 'banked' | 'repost') => {
    const description = resolution === 'banked'
      ? `Mark ${auction.itemName} as mailed to the bank?`
      : `Repost ${auction.itemName} for another 24 hours?`;
    if (!window.confirm(description)) return;

    setSaving(true);
    setError('');
    setNotice(resolution === 'banked' ? 'Saving bank delivery…' : 'Reposting auction…');
    try {
      const response = await fetch('/api/auction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'resolve-no-bid',
          auctionId: auction.id,
          resolution,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to resolve auction');
      setNotice(result.message);
      const resolvedAt = new Date();
      updateAuctionInView(auction.id, {
        deliveryStatus: resolution === 'banked' ? 'banked' : 'reposted',
        deliveredBy: sessionUser?.nickname ?? null,
        deliveredAt: resolvedAt.toISOString(),
        canResolveNoBid: false,
      });
      if (resolution === 'repost' && typeof result.auctionId === 'string') {
        addAuctionToView({
          ...auction,
          id: result.auctionId,
          createdBy: sessionUser?.nickname ?? auction.createdBy,
          isPoster: true,
          isWinner: false,
          canMarkDelivered: false,
          canRemove: true,
          createdAt: resolvedAt.toISOString(),
          endsAt: new Date(resolvedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
          biddingClosed: false,
          status: 'active',
          highBid: null,
          winner: null,
          deliveryStatus: 'not-required',
          deliveredBy: null,
          deliveredAt: null,
          settlementError: null,
          canResolveNoBid: false,
          canRetrySettlement: false,
        });
      }
      refreshInBackground(resolution === 'banked' ? 'Bank delivery saved.' : 'Auction reposted.');
    } catch (resolveError) {
      setNotice('');
      setError(resolveError instanceof Error ? resolveError.message : 'Unable to resolve auction');
    } finally {
      setSaving(false);
    }
  };

  const retrySettlement = async (auction: Auction) => {
    if (saving) return;
    setSaving(true); setError(''); setNotice('Retrying auction settlement…');
    try {
      const response=await fetch('/api/auction',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'retry-settlement',auctionId:auction.id})});
      const result=await response.json();
      if (!response.ok) throw new Error(result.error || 'Settlement could not be retried.');
      setNotice(result.message || 'Settlement retry requested.');
      updateAuctionInView(auction.id, { status: 'settling', canRetrySettlement: false, settlementError: null });
      notifyDkpChanged(); refreshInBackground('Settlement retry requested.');
    } catch (cause) { setNotice(''); setError(cause instanceof Error ? cause.message : 'Unable to retry settlement.'); }
    finally { setSaving(false); }
  };

  if (loading) {
    return <LoadingSurface fullLayout label="Preparing auction house" title="Auction house" />;
  }

  if (!data) {
    return <div className="space-y-4">
      <LoadingSurface fullLayout label="Auction house is waiting for data" title="Auction house" />
      <section className="surface flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-slate-300">
        <p role="alert">{error || 'Auction data is taking longer to arrive.'}</p>
        <button onClick={() => { setLoading(true); void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'Refresh failed.')).finally(() => setLoading(false)); }} className="secondary-button">Retry</button>
      </section>
    </div>;
  }

  const todoTasks = data.auctions.filter((auction) =>
    auction.canResolveNoBid || auction.canMarkDelivered,
  );
  const auctionsById = new Map(
    [...archiveAuctions, ...data.auctions].map((auction) => [auction.id, auction]),
  );
  const allAuctions = [...auctionsById.values()];
  const historyAuctions = archiveAuctions.map((auction) => auctionsById.get(auction.id) ?? auction);
  const wonAuctions = wonHistory.map((auction) => auctionsById.get(auction.id) ?? auction)
    .filter((auction) => auction.status === 'completed' && auction.isWinner && auction.winner);
  const auctionHolders = [...new Set(allAuctions.flatMap((auction) => {
    const bid = auction.winner ?? auction.highBid;
    return bid ? [bid.nickname] : [];
  }))].sort((first, second) => first.localeCompare(second));
  const filteredAuctions = (auctionView === 'all' ? historyAuctions : allAuctions).filter((auction) =>
    (!auctionRoleFilter || canRoleBid(auctionRoleFilter, auction.requiredRoles?.length ? auction.requiredRoles : [auction.requiredRole ?? ''])) &&
    (!auctionBossFilter || auction.bossType === auctionBossFilter) &&
    (!auctionHolderFilter ||
      auction.winner?.nickname === auctionHolderFilter ||
      (!auction.winner && auction.highBid?.nickname === auctionHolderFilter)) &&
    (!auctionSearch.trim() || [
      auction.itemName,
      auction.createdBy,
      auction.winner?.nickname,
      auction.winner?.owner,
      auction.winner?.account,
      auction.highBid?.nickname,
      auction.highBid?.owner,
      auction.highBid?.account,
    ].some((value) => value?.toLowerCase().includes(auctionSearch.trim().toLowerCase()))),
  );
  const activeAuctionFilterCount = [
    auctionRoleFilter,
    auctionBossFilter,
    auctionHolderFilter,
    auctionSearch.trim(),
  ].filter(Boolean).length;
  const liveAuctions = allAuctions.filter((auction) => ['active','settling'].includes(auction.status));
  const visibleAuctions = auctionView === 'live'
    ? filteredAuctions.filter((auction) => liveAuctions.some((live) => live.id === auction.id))
    : filteredAuctions;

  return (
    <div className="auction-page mx-auto max-w-6xl space-y-5 pb-8">
      <section className="auction-heading surface relative overflow-hidden">
        <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="relative flex flex-col gap-4 p-4 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-200 ring-1 ring-indigo-400/25"><Gavel className="h-5 w-5" /></div>
            <div>
              <p className="page-kicker">Centuri loot</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">Auction house</h1>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
            <div className="rounded-xl border border-slate-700 bg-slate-900/80 px-4 py-2.5"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Weekly DKP</p><p className="mt-0.5 text-lg font-black tabular-nums text-white">{lastSyncedAt ? data.weeklyEarnedTotal.toLocaleString() : '\u2014'} <span className="text-xs font-semibold text-slate-500">/ {data.weeklyMinimum.toLocaleString()}</span></p></div>
            <div className="rounded-xl border border-slate-700 bg-slate-900/80 px-4 py-2.5"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Live auctions</p><p className="mt-0.5 text-lg font-black tabular-nums text-emerald-300">{liveAuctions.length}</p></div>
            {data.manager && (
              <button type="button" onClick={() => { setNotice(''); setPostFormOpen(true); }} aria-haspopup="dialog" aria-expanded={postFormOpen} className="primary-button col-span-2 shrink-0 sm:col-span-1">
                <Plus className="h-4 w-4" /><span>Post auction</span>
              </button>
            )}
          </div>
        </div>
      </section>

      {!data.manager && (
        <p className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-sm text-slate-300">
          Auction posting is available to Chiefs, Generals, and Guardians.
        </p>
      )}

      {data.toons.some((toon) => toon.roleChange) && (
        <section className="rounded-2xl border border-indigo-300/20 bg-gradient-to-r from-indigo-400/[.08] via-slate-900/80 to-violet-400/[.06] p-4 sm:p-5" aria-label="Scheduled toon subclass changes">
          <div className="flex items-start gap-3"><CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-indigo-200" /><div className="min-w-0"><p className="text-xs font-bold text-white">Upcoming subclass changes</p><p className="mt-1 text-[11px] text-slate-400">Your current subclass remains eligible until its change date. After that, bids use the new subclass.</p>
            <div className="mt-3 flex flex-wrap gap-2">{data.toons.filter((toon) => toon.roleChange).map((toon) => <span key={toon.rowIndex} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-indigo-300/15 bg-slate-950/55 px-2.5 py-2 text-[10px] text-slate-300"><span className="max-w-32 truncate font-semibold text-white">{toon.account || toon.owner}</span><span>{toon.subClass} → {toon.roleChange!.scheduledRole}</span><span className="text-indigo-200">{new Date(toon.roleChange!.effectiveAt).toLocaleDateString(undefined, { timeZone: ROLE_CHANGE_TIME_ZONE, month: 'short', day: 'numeric' })}</span></span>)}</div>
          </div></div>
        </section>
      )}

      {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}
      {notice && <p role="status" aria-live="polite" className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm ${saving ? 'border border-indigo-400/20 bg-indigo-500/10 text-indigo-200' : 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300'}`}>{saving && <LoaderCircle size={15} className="animate-spin" />}{notice}</p>}
      {data.rosterSync?.stale && (
        <p role="status" className="rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-xs leading-relaxed text-amber-100">
          {data.rosterSync.refreshDelayed
            ? 'Google Sheets could not refresh; showing the cached roster.'
            : 'Showing the cached roster.'}
          {' Bids and DKP changes still require fresh Sheets data.'}
        </p>
      )}

      {active && data.manager && postFormOpen && <Dialog labelledBy="auction-post-dialog-title" busy={saving} onClose={() => setPostFormOpen(false)} className="auction-post-dialog">
        <header className="auction-post-dialog-header">
          <h2 id="auction-post-dialog-title" className="flex items-center gap-2 text-sm font-semibold text-amber-100"><Gavel size={17} />Post an auction</h2>
          <button type="button" disabled={saving} onClick={() => setPostFormOpen(false)} aria-label="Close auction posting" className="auction-icon-button"><X size={18} /></button>
        </header>
        {error && <p role="alert" className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}
        {saving && notice && <p role="status" aria-live="polite" className="mt-4 flex items-center gap-2 text-sm text-amber-100"><LoaderCircle size={15} className="animate-spin" />{notice}</p>}
        <AuctionPostingPanel
          items={data.items}
          selectedItemId={selectedItemId}
          onSelect={setSelectedItemId}
          saving={saving}
          onSubmit={submitAuction}
          onClose={() => setPostFormOpen(false)}
          onItemCreated={(item: AuctionCatalogItem) => {
            setData((current) => {
              if (!current) return current;
              const updated = { ...current, items: [...current.items.filter((entry) => entry.id !== item.id), item].sort((a, b) => a.name.localeCompare(b.name)) };
              dataRef.current = updated;
              rememberData('/api/auction', updated);
              rememberAuctionData(updated);
              return updated;
            });
            setSelectedItemId(item.id);
          }}
        />
      </Dialog>}
      {(data.manager || todoTasks.length > 0) && (
        <section className="rounded-2xl border border-amber-400/20 bg-slate-900/60 p-3 sm:p-4">
          <button
            type="button"
            onClick={() => setTodoListOpen((open) => !open)}
            aria-expanded={todoListOpen}
            aria-controls="auction-todo-list"
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-amber-400/10 bg-amber-400/[0.04] px-3 py-3 text-left transition hover:bg-amber-400/[0.08]"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <PackageCheck className="h-4 w-4 shrink-0 text-amber-300" />
              <span className="font-bold text-white">Auction follow-up</span>
              <span className="rounded-full bg-amber-400/10 px-2.5 py-1 text-xs font-bold tabular-nums text-amber-200">{todoTasks.length}</span>
            </span>
            {todoListOpen
              ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" />
              : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
          </button>
          {todoListOpen && <div id="auction-todo-list" className="mt-3 border-t border-slate-800 pt-4">
          {todoTasks.length === 0 ? (
            <p className="rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-5 text-sm text-slate-400">No auction follow-up tasks right now.</p>
          ) : (
            <div className="space-y-3">
              {todoTasks.map((auction) => (
                <article key={auction.id} className="flex flex-col justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 items-center gap-3">
                    <AuctionItemImage
                      itemId={auction.itemId}
                      imageCount={auction.imageCount}
                      alt={auction.itemName}
                      className="h-16 w-16 shrink-0 rounded-lg bg-slate-900 object-contain"
                    />
                    <div className="min-w-0">
                      <p className="break-words text-sm font-bold text-white">{auction.itemName}</p>
                      {auction.winner && (
                        <p className="break-words text-xs leading-snug text-slate-400">Mail to <span className="font-semibold text-amber-200">{auction.winner.account || auction.winner.owner}</span></p>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {auction.canMarkDelivered && (
                      <button disabled={saving} onClick={() => void markDelivered(auction)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-green-600 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-emerald-950/30 hover:from-emerald-500 hover:to-green-500 disabled:opacity-50">
                        <Check className="h-4 w-4" /> Confirm mailed
                      </button>
                    )}
                    {auction.canResolveNoBid && (
                      <>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void resolveNoBidAuction(auction, 'banked')}
                          className="inline-flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-200 transition hover:bg-amber-400/20 disabled:opacity-50"
                        >
                          <PackageCheck className="h-3.5 w-3.5" /> Mail to bank
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void resolveNoBidAuction(auction, 'repost')}
                          className="inline-flex items-center gap-2 rounded-lg border border-indigo-400/30 bg-indigo-400/10 px-3 py-2 text-xs font-semibold text-indigo-200 transition hover:bg-indigo-400/20 disabled:opacity-50"
                        >
                          <RefreshCw className="h-3.5 w-3.5" /> Repost
                        </button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
          </div>}
        </section>
      )}

      {(
        <section className="rounded-2xl border border-emerald-400/20 bg-slate-900/60 p-3 sm:p-4">
          <button
            type="button"
            onClick={() => { setWonItemsOpen((open) => !open); if (!wonItemsOpen && !wonLoaded && !wonLoading) void loadWonHistory(); }}
            aria-expanded={wonItemsOpen}
            aria-controls="auction-won-items"
            className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-slate-800/60"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <Trophy className="h-4 w-4 shrink-0 text-emerald-300" />
              <span className="font-bold text-white">Items you won</span>
              <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs font-bold tabular-nums text-emerald-200">{wonLoaded ? wonAuctions.length : 'View'}</span>
            </span>
            {wonItemsOpen
              ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" />
              : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
          </button>
          {wonItemsOpen && (
            <div id="auction-won-items" className="mt-3 space-y-3 border-t border-slate-800 pt-4">
              {wonLoading && <p role="status" className="text-sm text-slate-400">Loading your wins...</p>}
              {!wonLoaded && !wonLoading && <button type="button" className="secondary-button" onClick={() => void loadWonHistory()}>Retry loading wins</button>}
              {wonCursor && <button type="button" className="secondary-button" disabled={wonLoading} onClick={() => void loadWonHistory(true)}>Load older wins</button>}
              {wonLoaded && !wonLoading && wonAuctions.length === 0 && <p className="text-sm text-slate-400">No completed wins found in the loaded history.</p>}
              {wonAuctions.map((auction) => (
                <article key={auction.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-bold text-white">{auction.itemName}</p>
                    {auction.deliveryStatus !== 'done' && <p className="mt-1 text-[11px] text-slate-400">Awaiting mail</p>}
                    {auction.deliveryStatus === 'done' && auction.winner && (
                      <p className="mt-1 break-words text-[11px] text-emerald-300">{mailedItemSummary(auction)}</p>
                    )}
                  </div>
                  <span className="shrink-0 rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-xs font-bold tabular-nums text-amber-200">
                    −{auction.winner?.amount.toLocaleString()} DKP
                  </span>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="space-y-4">
        <div className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div><h2 className="text-lg font-bold text-white">Browse auctions</h2><p role="status" className="text-xs text-slate-500">{auctionView === 'live' ? `${liveAuctions.length} live or finalizing` : `${historyAuctions.length} history records loaded`}</p></div>
            <div className="flex rounded-xl border border-slate-700 bg-slate-950 p-1" role="group" aria-label="Auction views">
              <button type="button" aria-pressed={auctionView === 'live'} onClick={() => setAuctionView('live')} className={`rounded-lg px-3 py-2 text-xs font-bold transition ${auctionView === 'live' ? 'bg-indigo-500 text-white shadow' : 'text-slate-400 hover:text-white'}`}>Live <span className="ml-1 tabular-nums opacity-75">{liveAuctions.length}</span></button>
              <button type="button" aria-pressed={auctionView === 'all'} onClick={() => setAuctionView('all')} className={`rounded-lg px-3 py-2 text-xs font-bold transition ${auctionView === 'all' ? 'bg-indigo-500 text-white shadow' : 'text-slate-400 hover:text-white'}`}>All history</button>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
          <label className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={auctionSearch}
              onChange={(event) => setAuctionSearch(event.target.value)}
              placeholder="Search item, poster, or bidder..."
              aria-label="Search auctions by item, poster, or bidder"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-xs text-slate-200 outline-none placeholder:text-slate-500 focus:border-indigo-400/60"
            />
          </label>
          <button
            type="button"
            onClick={() => setAuctionFiltersOpen((open) => !open)}
              aria-expanded={auctionFiltersOpen}
              aria-controls="auction-filters"
              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                activeAuctionFilterCount
                  ? 'border-indigo-400/30 bg-indigo-400/10 text-indigo-200'
                  : 'border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Filter className="h-4 w-4" /> Filter
              {activeAuctionFilterCount > 0 && <span className="rounded-full bg-indigo-400/20 px-1.5 py-0.5">{activeAuctionFilterCount}</span>}
            </button>
          </div>
        </div>

        {auctionFiltersOpen && <div id="auction-filters" className="grid gap-2 rounded-2xl border border-slate-800 bg-slate-900/50 p-3 sm:grid-cols-3">
          <label className="space-y-1 text-[11px] font-semibold text-slate-400">
            <span>Filter by role</span>
            <select value={auctionRoleFilter} onChange={(event) => setAuctionRoleFilter(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-xs text-slate-200">
              <option value="">All roles</option>
              {data.roles.map((role) => <option key={role} value={role}>{role}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-[11px] font-semibold text-slate-400">
            <span>Filter by boss</span>
            <select value={auctionBossFilter} onChange={(event) => setAuctionBossFilter(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-xs text-slate-200">
              <option value="">All bosses</option>
              <option value="Prot">Prot (Base / Prime)</option>
              <option value="Bt">Bt</option>
              <option value="Gele">Gele</option>
              <option value="Dino">Dino</option>
              <option value="Crom">Crom</option>
              <option value="Legacy">Legacy</option>
              <option value="Unassigned">Unassigned</option>
            </select>
          </label>
          <label className="space-y-1 text-[11px] font-semibold text-slate-400">
            <span>Filter by item holder / winner</span>
            <select value={auctionHolderFilter} onChange={(event) => setAuctionHolderFilter(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-xs text-slate-200">
              <option value="">All holders</option>
              {auctionHolders.map((holder) => <option key={holder} value={holder}>{holder}</option>)}
            </select>
          </label>
          {activeAuctionFilterCount > 0 && (
            <button
              type="button"
              onClick={() => {
                setAuctionRoleFilter('');
                setAuctionBossFilter('');
                setAuctionHolderFilter('');
                setAuctionSearch('');
              }}
              className="text-left text-xs font-semibold text-indigo-300 hover:text-indigo-200 sm:col-span-3"
            >
              Clear filters
            </button>
          )}
        </div>}

        {auctionView === 'all' && archiveLoading && (
          <p role="status" className="flex items-center gap-2 rounded-xl border border-indigo-400/20 bg-indigo-400/5 px-4 py-3 text-sm text-indigo-200"><LoaderCircle className="h-4 w-4 animate-spin" /> Loading auction history…</p>
        )}
        {auctionView === 'all' && archiveLoaded && (
          <p role="status" className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3 text-xs text-slate-400">{historyAuctions.length} history records loaded{archiveCursor ? ' · Load older auctions to see more.' : ' · All available history loaded.'}</p>
        )}
        {auctionView === 'all' && archiveCursor && <button type="button" className="secondary-button w-full" disabled={archiveLoading} onClick={() => void loadFullAuctionHistory(true)}>{archiveLoading ? <LoaderCircle size={15} className="animate-spin" /> : <Clock3 size={15} />}Load older auctions</button>}
        {auctionView === 'all' && !archiveLoaded && !archiveLoading && error && (
          <button type="button" onClick={() => void loadFullAuctionHistory()} className="rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-left text-sm text-red-200">History did not load. Select here to retry.</button>
        )}

        {auctionView === 'all' && archiveLoaded && historyAuctions.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 px-5 py-12 text-center">
            <Gavel className="mx-auto h-7 w-7 text-slate-600" />
            <p className="mt-3 text-sm text-slate-400">There are no auctions yet.</p>
          </div>
        ) : visibleAuctions.length === 0 ? (
          <div>
            <EmptyState title={auctionView === 'live' && liveAuctions.length === 0 ? 'No live auctions right now' : 'No auctions match your filters'} description="Try another search or browse completed auctions." onReset={auctionSearch || activeAuctionFilterCount ? () => { setAuctionSearch(''); setAuctionRoleFilter(''); setAuctionBossFilter(''); setAuctionHolderFilter(''); } : undefined} />
            {auctionView === 'live' && liveAuctions.length === 0 && <button type="button" onClick={() => setAuctionView('all')} className="secondary-button mt-3">Browse auction history</button>}
          </div>
        ) : (
          <div className="mx-auto grid w-full max-w-3xl grid-cols-1 items-start gap-3">
            {visibleAuctions.map((auction) => {
              const isActive = auction.status === 'active' && !auction.biddingClosed && new Date(auction.endsAt).getTime() > now;
              const auctionRoles = auction.requiredRoles?.length ? auction.requiredRoles : [auction.requiredRole ?? ''];
              const eligibleToons = data.toons.filter((toon) =>
                toon.canBid !== false && toon.available !== null && canRoleBid(toon.subClass, auctionRoles),
              );
              const selectedRow = selectedToons[auction.id] ?? eligibleToons[0]?.rowIndex;
              const selectedToon = eligibleToons.find((toon) => toon.rowIndex === selectedRow);
              const toonMaximumBid = (toon: AuctionToon) => Math.max(
                0,
                (toon.available ?? 0) - toon.heldPoints + (
                  auction.highBid?.isMine && auction.highBid.rowIndex === toon.rowIndex ? auction.highBid.amount : 0
                ),
              );
              const maxBid = selectedToon ? toonMaximumBid(selectedToon) : 0;
              const minimumBid = (auction.highBid?.amount ?? 0) + 1;
              const roleStyle = roleStyles[normalizeAuctionRole(auctionRoles[0] ?? '')] ?? 'border-slate-700 bg-slate-800 text-slate-300';

              return (
                <article key={auction.id} aria-labelledby={`auction-title-${auction.id}`} data-active={isActive} className="auction-card group min-w-0 overflow-hidden rounded-2xl border border-slate-800">
                  <header className="auction-card-header">
                    <div className="auction-card-heading min-w-0">
                      <p className="auction-card-kicker">{auction.bossType} <span aria-hidden="true">/</span> Clan loot</p>
                      <h3 id={`auction-title-${auction.id}`} className="break-words">{auction.itemName}</h3>
                    </div>
                    <div className="auction-role-strip flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Eligible roles">
                      {auctionRoles.map((role) => <RoleBadge key={role} role={role} gameClass className="shrink-0" />)}
                    </div>
                    <div className="auction-card-status flex shrink-0 items-center gap-1.5">
                      {!isActive && <span className={`rounded-full px-2 py-1 text-[10px] font-bold tracking-wider ${auction.status === 'settlement-failed' ? 'bg-red-400/10 text-red-300' : 'bg-slate-800 text-slate-300'}`}>{auction.status === 'settling' || auction.status === 'active' ? 'FINALIZING' : auction.status === 'settlement-failed' ? 'REVIEW' : 'ENDED'}</span>}
                      {isActive && active && <AuctionCountdown endsAt={auction.endsAt} />}
                      {isActive && auction.canRemove && <button type="button" disabled={saving} onClick={() => void removeAuction(auction)} className="auction-remove inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 transition hover:bg-rose-400/10 hover:text-rose-200 disabled:cursor-wait disabled:opacity-50" aria-label={`Remove ${auction.itemName} auction`} title="Remove auction"><X className="h-4 w-4" strokeWidth={2} /></button>}
                    </div>
                  </header>

                  <div className="auction-card-body grid items-start sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                    <div className="auction-item-visual min-w-0 overflow-hidden">
                      <AuctionItemImage itemId={auction.itemId} imageCount={auction.imageCount} alt={auction.itemName} showNameOnError className="auction-item-image relative aspect-[8/7] w-full" />
                    </div>
                    <div className="auction-card-details flex min-w-0 flex-col gap-3">
                    {auction.highBid && (
                      <div className="auction-leading-bid flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border p-3" data-mine={isActive && auction.highBid.isMine}>
                        <div className="min-w-0 flex-1">
                          <p className={`text-[10px] font-medium ${isActive && auction.highBid.isMine ? 'text-emerald-300' : 'text-slate-400'}`}>{auction.status === 'completed' ? 'Winner' : isActive && auction.highBid.isMine ? 'You lead' : isActive ? 'Leading' : 'Last bid'}</p>
                          <p className="break-all text-sm font-semibold leading-snug text-slate-100">{auction.highBid.account || auction.highBid.owner}</p>
                        </div>
                        <p aria-live="polite" className="min-w-0 break-all text-right text-2xl font-bold tracking-tight tabular-nums text-amber-100">{auction.highBid.amount.toLocaleString()} <span className="text-[10px] font-semibold tracking-normal text-amber-200/70">DKP</span></p>
                      </div>
                    )}

                    {auction.status === 'completed' && !auction.highBid && auction.deliveryStatus === 'banked' && (
                      <p className="text-xs text-amber-200">Mailed to bank by {auction.deliveredBy}</p>
                    )}
                    {auction.status === 'completed' && !auction.highBid && auction.deliveryStatus === 'reposted' && (
                      <p className="text-xs text-indigo-200">Reposted by {auction.deliveredBy}</p>
                    )}

                    {isActive && eligibleToons.length > 0 && data.canBidWeekly && (
                      <div className="auction-bid-controls space-y-2.5">
                        {eligibleToons.length === 1 ? (
                          <div className="px-0.5 py-1">
                            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
                              <p className="min-w-0 break-all text-slate-300" title={eligibleToons[0].subClass}><span className="sr-only">Bidding as </span>{eligibleToons[0].account || eligibleToons[0].owner}{auctionRoles.some((role) => normalizeAuctionRole(role) === 'everyone') && <span className="text-slate-400"> · {eligibleToons[0].subClass}</span>}</p>
                              <p className="text-slate-400">Max <span className="font-semibold tabular-nums text-slate-200">{toonMaximumBid(eligibleToons[0]).toLocaleString()} DKP</span></p>
                            </div>
                            {eligibleToons[0].roleChange && <p className="mt-1 text-[10px] text-indigo-200/80">Switches to {eligibleToons[0].roleChange.scheduledRole} on {new Date(eligibleToons[0].roleChange.effectiveAt).toLocaleDateString(undefined, { timeZone: ROLE_CHANGE_TIME_ZONE, month: 'short', day: 'numeric' })} · role change scheduled</p>}
                          </div>
                        ) : (
                          <label className="block min-w-0">
                            <span className="sr-only">Choose toon and role</span>
                            <select aria-label="Choose toon and role to bid with" value={selectedRow ?? ''} onChange={(event) => setSelectedToons((current) => ({ ...current, [auction.id]: Number(event.target.value) }))} className="h-11 w-full min-w-0 rounded-xl border border-slate-700 bg-slate-950 px-3 text-base text-white outline-none focus:border-amber-200/60">
                              {eligibleToons.map((toon) => <option key={toon.rowIndex} value={toon.rowIndex}>{toon.account || toon.owner} · {toon.subClass} · Max {toonMaximumBid(toon).toLocaleString()} DKP</option>)}
                            </select>
                          </label>
                        )}
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                          <label className="min-w-0">
                            <span className="sr-only">Bid amount</span>
                            <input aria-label={`Bid on ${auction.itemName}`} aria-describedby={maxBid < minimumBid ? `bid-help-${auction.id}` : undefined} inputMode="numeric" type="number" min={minimumBid} max={maxBid} step={1} value={bidAmounts[auction.id] ?? ''} onChange={(event) => setBidAmounts((current) => ({ ...current, [auction.id]: event.target.value }))} placeholder="DKP amount" className="h-11 w-full min-w-0 rounded-xl border border-slate-700 bg-slate-950/70 px-3 text-base text-white outline-none placeholder:text-slate-500 focus:border-amber-200/60" />
                          </label>
                          <button aria-label={`Place bid on ${auction.itemName}`} disabled={saving || syncing || !lastSyncedAt || !Number.isSafeInteger(Number(bidAmounts[auction.id])) || !selectedToon || maxBid < minimumBid || Number(bidAmounts[auction.id]) < minimumBid || Number(bidAmounts[auction.id]) > maxBid} onClick={() => void submitBid(auction)} className="primary-button auction-bid-button disabled:opacity-45">
                            <Gavel className="h-4 w-4" /> Bid
                          </button>
                        </div>
                        {maxBid < minimumBid && <p id={`bid-help-${auction.id}`} className="text-xs text-slate-400">Insufficient available DKP.</p>}
                      </div>
                    )}

                    {auction.status === 'settlement-failed' && auction.settlementError && (
                      <p role="alert" className="flex gap-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-300"><ShieldAlert className="h-4 w-4 shrink-0" />{auction.settlementError}</p>
                    )}
                    {auction.canRetrySettlement && <button type="button" className="secondary-button" disabled={saving} onClick={() => void retrySettlement(auction)}><RefreshCw size={13} />Retry settlement</button>}
                    {!isActive && auction.status === 'completed' && auction.winner && auction.deliveryStatus === 'done' && (
                      <p className="flex items-start gap-2 break-words text-xs leading-snug text-emerald-300">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>{mailedItemSummary(auction)}</span>
                      </p>
                    )}
                    </div>
                  </div>
                  <footer className="auction-card-footer flex min-w-0 items-center justify-between gap-2 px-3 py-2 text-[10px] text-slate-400">
                    <span className="min-w-0 break-words">by <span className="text-slate-300">{auction.createdBy}</span></span>
                    <time dateTime={auction.createdAt} className="shrink-0">{localTimeReady ? new Date(auction.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '…'}</time>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
