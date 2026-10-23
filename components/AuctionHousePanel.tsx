'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock3, Filter, Gavel, ImageOff, LoaderCircle, PackageCheck, Plus, RefreshCw, Search, ShieldAlert, Sparkles, Trophy, X } from 'lucide-react';
import LoadingSurface from '@/components/LoadingSurface';
import RoleBadge from '@/components/RoleBadge';
import RosterDataIssues from '@/components/RosterDataIssues';
import type { DkpCellIssue } from '@/lib/sheetRoster';
import { ApiError, getData, clientDataVersion, peekData, rememberData, clearClientData, notifyDkpChanged } from '@/lib/client/api';
import { normalizeAuctionRole, canRoleBid, resolveItemSubroles } from '@/lib/auctionRules';
import { useAutoRefresh } from '@/lib/client/useAutoRefresh';
import { useSessionUser } from '@/components/AppShell';
import { getActionRequestId, completeActionRequest } from '@/lib/client/actionRequests';

interface AuctionToon {
  rowIndex: number;
  owner: string;
  account: string;
  subClass: string;
  weeklyEarned: number;
  available: number | null;
  heldPoints: number;
  canBid?: boolean;
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
  canClose: boolean;
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
      canClose: false,
      canResolveNoBid: false,
      canRetrySettlement: false,
      highBid: auction.highBid ? { ...auction.highBid, isMine: false } : null,
      winner: auction.winner ? { ...auction.winner, isMine: false } : null,
    })),
  };
  rememberData(AUCTION_PREVIEW_CACHE_KEY, preview);
}

function readAuctionCache() { return peekData<AuctionData>(AUCTION_PREVIEW_CACHE_KEY); }

const roleStyles: Record<string, string> = {
  ranger: 'border-yellow-400/30 bg-yellow-400/10 text-yellow-300',
  'dps rogue': 'border-violet-400/30 bg-violet-400/10 text-violet-300',
  'fire mage': 'border-orange-700/40 bg-orange-800/20 text-orange-300',
  'ice mage': 'border-sky-300/30 bg-sky-300/10 text-sky-200',
  'support druid': 'border-green-400/30 bg-green-400/10 text-green-300',
  'dps druid': 'border-purple-800/50 bg-purple-900/30 text-purple-300',
  'support rogue': 'border-rose-600/40 bg-rose-700/20 text-rose-300',
  'dps warrior': 'border-red-400/30 bg-red-400/10 text-red-300',
  tank: 'border-pink-400/30 bg-pink-400/10 text-pink-300',
};

function formatRemaining(endsAt: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(endsAt).getTime() - now) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours === 0) return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
  return `${hours}h ${minutes}m ${remainingSeconds}s`;
}

function AuctionItemImage({ itemId, imageCount, alt, className }: {itemId:string; imageCount:number; alt:string; className:string}) {
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const [imageIndex, setImageIndex] = useState(0);
  const [readyItemId, setReadyItemId] = useState<string | null>(null);
  const [loadedSource, setLoadedSource] = useState<string | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const total = Math.max(1,imageCount);
  const source = `/api/auction/image?id=${encodeURIComponent(itemId)}&index=${imageIndex}`;
  const shouldLoad = readyItemId === itemId;
  const loaded = loadedSource === source;
  const failed = failedSource === source;

  useEffect(() => {
    setImageIndex(0);
    const container = imageContainerRef.current;
    if (!container) return;
    if (!('IntersectionObserver' in window)) {
      setReadyItemId(itemId);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setReadyItemId(itemId);
        observer.disconnect();
      }
    }, { rootMargin: '220px 0px' });
    observer.observe(container);
    return () => observer.disconnect();
  }, [itemId]);

  const changeImage = (index:number) => setImageIndex(index);
  return <div className={`${className} relative overflow-hidden`}>
    <div ref={imageContainerRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />
    {!failed && shouldLoad && <img src={source} alt={`${alt}, image ${imageIndex+1}`} loading="lazy" decoding="async" onLoad={() => setLoadedSource(source)} onError={() => setFailedSource(source)} className={`h-full w-full object-cover transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`} />}
    {!loaded && !failed && <div className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.2)_0%,rgba(15,23,42,0.92)_58%,rgba(2,6,23,1)_100%)]" aria-hidden="true">
      <div className="absolute inset-x-[18%] top-1/2 h-px bg-gradient-to-r from-transparent via-amber-200/35 to-transparent" />
      <div className="relative grid h-9 w-9 place-items-center rounded-2xl border border-amber-200/25 bg-slate-950/55 text-amber-200 shadow-[0_0_28px_rgba(251,191,36,0.16)] animate-pulse">
        <Sparkles className="h-4 w-4" />
      </div>
    </div>}
    {failed && <div role="img" aria-label={`${alt}: image unavailable`} className="flex h-full min-h-10 flex-col items-center justify-center gap-1 text-[9px] text-slate-500"><ImageOff size={17} />Image unavailable</div>}
    {total > 1 && <ImageNavigation imageIndex={imageIndex} imageTotal={total} setImageIndex={changeImage} />}
  </div>;
}

function ImageNavigation({
  imageIndex,
  imageTotal,
  setImageIndex,
}: {
  imageIndex: number;
  imageTotal: number;
  setImageIndex: (index: number) => void;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Previous item image"
        onClick={() => setImageIndex((imageIndex + imageTotal - 1) % imageTotal)}
        className="absolute left-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-slate-950/80 text-white shadow-lg backdrop-blur hover:bg-slate-800"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="absolute bottom-1 right-1 rounded-full border border-white/10 bg-slate-950/80 px-2 py-0.5 text-[10px] font-semibold text-white shadow-lg">
        {imageIndex + 1}/{imageTotal}
      </span>
      <button
        type="button"
        aria-label="Next item image"
        onClick={() => setImageIndex((imageIndex + 1) % imageTotal)}
        className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-slate-950/80 text-white shadow-lg backdrop-blur hover:bg-slate-800"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </>
  );
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
  const [selectedItemId, setSelectedItemId] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [itemResultLimit, setItemResultLimit] = useState(40);
  const [auctionRoleFilter, setAuctionRoleFilter] = useState('');
  const [auctionBossFilter, setAuctionBossFilter] = useState('');
  const [auctionHolderFilter, setAuctionHolderFilter] = useState('');
  const [auctionSearch, setAuctionSearch] = useState('');
  const [auctionFiltersOpen, setAuctionFiltersOpen] = useState(false);
  const [archiveAuctions, setArchiveAuctions] = useState<Auction[]>([]);
  const [archiveLoaded, setArchiveLoaded] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveCursor, setArchiveCursor] = useState<string | null>(null);
  const archivePageCount = useRef(1);
  const archiveLoadedRef = useRef(false);
  const archiveSequence = useRef(0);
  const [selectedToons, setSelectedToons] = useState<Record<string, number>>({});
  const [bidAmounts, setBidAmounts] = useState<Record<string, string>>({});
  const [auctionView, setAuctionView] = useState<'live' | 'all'>('live');
  const router = useRouter();

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    setLocalTimeReady(true);
  }, []);

  useEffect(() => {
    let mounted = true;
    let pollInFlight = false;
    let pollFailures = 0;
    let nextPollAt = 0;
    let lastIdlePollAt = 0;
    const pollLiveAuctions = async () => {
      const current = dataRef.current;
      if (!current || pollInFlight || fullRefreshCount.current > 0 || !activeRef.current || document.visibilityState !== 'visible' || navigator.onLine === false || Date.now() < nextPollAt) return;
      const hasLiveAuctions = current.auctions.some((auction) =>
        ['active','settling','settlement-failed'].includes(auction.status),
      );
      if (!hasLiveAuctions && Date.now() - lastIdlePollAt < 5 * 60_000) return;
      if (!hasLiveAuctions) lastIdlePollAt = Date.now();
      pollInFlight = true;
      const pollGeneration = clientDataVersion();
      const epoch = liveEpoch.current;
      try {
        const versions = [...current.auctions]
          .sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime())
          .slice(0, 100)
          .map((auction) => [auction.id, auction.versionToken ?? `${auction.bidVersion ?? 0}:${auction.status}:${auction.endsAt}:${auction.deliveryStatus}:${auction.itemId}`]);
        const response = await fetch(`/api/auction?live=1&versions=${encodeURIComponent(JSON.stringify(versions))}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Live bid updates are delayed. Retrying automatically.');
        const result = await response.json();
        if (!mounted || pollGeneration !== clientDataVersion() || epoch !== liveEpoch.current) return;
        pollFailures = 0; nextPollAt = 0;
        setError('');
        setLastSyncedAt(Date.now());
        if (!result.changed || !Array.isArray(result.auctions)) return;
        const personalBalanceChanged = (result.auctions as Auction[]).some((live) => { const old=current.auctions.find((entry) => entry.id === live.id); return Boolean(old?.highBid?.isMine || live.highBid?.isMine || old?.winner?.isMine) && (old?.bidVersion !== live.bidVersion || old?.status !== live.status || old?.highBid?.amount !== live.highBid?.amount); });
        const byId = new Map((result.auctions as Auction[]).map((auction) => [auction.id, auction]));
        setData((previous) => {
          if (!previous) return previous;
          const updated = {
            ...previous,
            auctions: previous.auctions.filter((auction) => !(result.removedIds as string[] | undefined)?.includes(auction.id)).map((auction) => {
              const live = byId.get(auction.id);
              return live ? { ...auction, ...live } : auction;
            }).concat((result.auctions as Auction[]).filter((live) => !previous.auctions.some((auction) => auction.id === live.id)))
              .sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime()),
          };
          dataRef.current = updated;
          rememberAuctionData(updated);
          return updated;
        });
        setArchiveAuctions((previous) => previous
          .filter((auction) => !(result.removedIds as string[] | undefined)?.includes(auction.id))
          .map((auction) => byId.has(auction.id) ? { ...auction, ...byId.get(auction.id)! } : auction));
        setLastSyncedAt(Date.now());
        if (personalBalanceChanged) await refresh();
      } catch (cause) {
        pollFailures += 1;
        nextPollAt = Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(pollFailures - 1, 4));
        if (mounted) setError(cause instanceof Error ? cause.message : 'Live updates are delayed. Retrying automatically.');
      } finally {
        pollInFlight = false;
      }
    };
    // Poll only compact auction state frequently; reload roster/catalog less often.
    const refreshTimer = window.setInterval(() => void pollLiveAuctions(), 30_000 + Math.floor(Math.random() * 5_000));
    const clockTimer = window.setInterval(() => { if (activeRef.current && document.visibilityState === 'visible') setNow(Date.now()); }, 1000);
    return () => {
      mounted = false;
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, [router]);

  const refresh = async () => {
    fullRefreshCount.current += 1; liveEpoch.current += 1;
    setSyncing(true);
    const version = clientDataVersion();
    try {
      const result = await getData<AuctionData>('/api/auction');
      if (version !== clientDataVersion()) return;
      setError('');
      dataRef.current = result;
      setData(result);
      rememberAuctionData(result);
      setLastSyncedAt(Date.now());
      setSyncing(false);
      if (archiveLoadedRef.current) await loadFullAuctionHistory();
    } catch (refreshError) {
      setSyncing(false);
      if (refreshError instanceof ApiError && refreshError.status === 401) { clearClientData(); router.replace('/login'); return false; }
      throw refreshError;
    } finally {
      fullRefreshCount.current = Math.max(0, fullRefreshCount.current - 1);
      if (version === clientDataVersion()) setLoading(false);
    }
  };
  useAutoRefresh(refresh, { active, intervalMs: 180_000, onError: (cause) => setError(cause instanceof Error ? cause.message : 'Auction updates are delayed. Retrying automatically.') });

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
    const clear = () => { archiveSequence.current += 1; archivePageCount.current = 1; archiveLoadedRef.current = false; setArchiveCursor(null); setArchiveLoading(false); setData(null); dataRef.current = null; setArchiveAuctions([]); setArchiveLoaded(false); setAuctionView('live'); setSelectedToons({}); setBidAmounts({}); setLastSyncedAt(0); setLoading(true); setSyncing(false); setPostFormOpen(false); setError(''); setNotice(''); };
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
      let cursor = append ? archiveCursor : null;
      const combined: Auction[] = [];
      const pages = append ? 1 : archivePageCount.current;
      for (let page = 0; page < pages; page += 1) {
        const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const result = await getData<AuctionData>(`/api/auction?includeArchive=1${suffix}`);
        if (version !== clientDataVersion() || sequence !== archiveSequence.current) return;
        combined.push(...result.auctions); cursor = result.nextCursor ?? null;
        if (!cursor) break;
      }
      if (append) archivePageCount.current += 1;
      setArchiveCursor(cursor);
      setArchiveAuctions((previous) => [...new Map([...(append ? previous : []), ...combined].map((auction) => [auction.id, auction])).values()]);
      archiveLoadedRef.current = true;
      setArchiveLoaded(true);
    } catch (historyError) {
      if (version === clientDataVersion() && sequence === archiveSequence.current) setError(historyError instanceof Error ? historyError.message : 'Unable to load full auction history');
    } finally {
      if (version === clientDataVersion() && sequence === archiveSequence.current) setArchiveLoading(false);
    }
  };

  useEffect(() => {
    if (auctionView === 'all' && !archiveLoaded && !archiveLoading) {
      void loadFullAuctionHistory();
    }
  }, [auctionView]);

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
          canClose: true,
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

  const markDelivered = async (auctionId: string) => {
    setSaving(true);
    setError('');
    setNotice('Saving delivery update…');
    try {
      const response = await fetch('/api/auction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark-delivered', auctionId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to update delivery task');
      setNotice(result.message || 'Item marked mailed.');
      updateAuctionInView(auctionId, { deliveryStatus: 'done', deliveredBy: sessionUser?.nickname ?? null, deliveredAt: new Date().toISOString(), canMarkDelivered: false });
      refreshInBackground('Delivery update saved.');
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

  const closeAuction = async (auction: Auction) => {
    const outcome = auction.highBid
      ? `${auction.highBid.account || auction.highBid.owner} at ${auction.highBid.amount.toLocaleString()} DKP will win.`
      : 'This auction will close with no bids and can be sent to the bank or reposted.';
    if (!window.confirm(`Close bidding on ${auction.itemName} now? ${outcome}`)) return;

    setSaving(true);
    setError('');
    setNotice('Closing bidding…');
    try {
      const response = await fetch('/api/auction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close-auction', auctionId: auction.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to close auction');
      setNotice(result.message || 'Bidding closed.');
      updateAuctionInView(auction.id, { biddingClosed: true, endsAt: new Date().toISOString(), canClose: false });
      refreshInBackground('Bidding closed.');
    } catch (closeError) {
      setNotice('');
      setError(closeError instanceof Error ? closeError.message : 'Unable to close auction');
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
          canClose: true,
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
      refreshInBackground('Settlement retry requested.'); notifyDkpChanged();
    } catch (cause) { setNotice(''); setError(cause instanceof Error ? cause.message : 'Unable to retry settlement.'); }
    finally { setSaving(false); }
  };

  if (loading) {
    return <LoadingSurface fullLayout label="Preparing auction house" title="Find your next upgrade." />;
  }

  if (!data) {
    return <div className="space-y-4">
      <LoadingSurface fullLayout label="Auction house is waiting for data" title="Find your next upgrade." />
      <section className="surface flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-slate-300">
        <p role="alert">{error || 'Auction data is taking longer to arrive.'}</p>
        <button onClick={() => { setLoading(true); void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'Refresh failed.')).finally(() => setLoading(false)); }} className="secondary-button">Retry</button>
      </section>
    </div>;
  }

  const filteredItems = data.items.filter((item) =>
    item.name.toLowerCase().includes(itemSearch.trim().toLowerCase()),
  );
  const visibleItems = filteredItems.slice(0, itemResultLimit);
  const selectedCatalogItem = data.items.find((item) => item.id === selectedItemId);
  const selectedItemRoleIsValid = Boolean(selectedCatalogItem && resolveItemSubroles(selectedCatalogItem.requiredRoles));
  const todoTasks = data.auctions.filter((auction) =>
    auction.canResolveNoBid || auction.canMarkDelivered,
  );
  const allAuctions = [...new Map(
    [...archiveAuctions, ...data.auctions].map((auction) => [auction.id, auction]),
  ).values()];
  const wonAuctions = allAuctions.filter((auction) =>
    auction.status === 'completed' && auction.isWinner && auction.winner,
  );
  const auctionHolders = [...new Set(allAuctions.flatMap((auction) => {
    const bid = auction.winner ?? auction.highBid;
    return bid ? [bid.nickname] : [];
  }))].sort((first, second) => first.localeCompare(second));
  const filteredAuctions = allAuctions.filter((auction) =>
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
    <div className="mx-auto max-w-6xl space-y-5 pb-8">
      <section className="surface relative overflow-hidden">
        <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="relative flex flex-col gap-5 p-5 sm:p-7 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-200 ring-1 ring-indigo-400/25"><Gavel className="h-5 w-5" /></div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-indigo-300">Centuri loot</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">Find your next upgrade.</h1>
              <p className="mt-1 text-sm text-slate-400">Browse live items, check the lead, and place a bid.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
            <div className="rounded-xl border border-slate-700 bg-slate-900/80 px-4 py-2.5"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Weekly DKP</p><p className="mt-0.5 text-lg font-black tabular-nums text-white">{lastSyncedAt ? data.weeklyEarnedTotal.toLocaleString() : '\u2014'} <span className="text-xs font-semibold text-slate-500">/ {data.weeklyMinimum.toLocaleString()}</span></p></div>
            <div className="rounded-xl border border-slate-700 bg-slate-900/80 px-4 py-2.5"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Live auctions</p><p className="mt-0.5 text-lg font-black tabular-nums text-emerald-300">{liveAuctions.length}</p></div>
            {data.manager && (
              <button
                type="button"
                onClick={() => setPostFormOpen((open) => !open)}
                aria-expanded={postFormOpen}
                aria-controls="auction-post-form"
                aria-label={postFormOpen ? 'Close auction post form' : 'Post an auction'}
                className="col-span-2 inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-indigo-500 px-4 text-sm font-bold text-white shadow-lg shadow-indigo-950/30 transition hover:bg-indigo-400 sm:col-span-1"
              >
                {postFormOpen ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                <span>{postFormOpen ? 'Close form' : 'Post auction'}</span>
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

      {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}
      {notice && <p role="status" aria-live="polite" className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm ${saving ? 'border border-indigo-400/20 bg-indigo-500/10 text-indigo-200' : 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300'}`}>{saving && <LoaderCircle size={15} className="animate-spin" />}{notice}</p>}
      {data.rosterSync?.stale && (
        <p role="status" className="rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-xs leading-relaxed text-amber-100">
          {data.rosterSync.refreshDelayed
            ? 'Google Sheets could not refresh; showing the cached roster'
            : 'Showing the cached roster while Google Sheets refreshes'}
          {' · Last updated '}
          {new Date(data.rosterSync.fetchedAt).toLocaleTimeString()}.
          {' Bids and DKP changes still require a fresh Sheets check.'}
        </p>
      )}

      {data.manager && postFormOpen && (
        <section id="auction-post-form" className="rounded-2xl border border-emerald-400/20 bg-slate-900/60 p-5 shadow-lg sm:p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-400/20 bg-emerald-400/10 text-emerald-300"><Sparkles className="h-4 w-4" /></div>
            <div>
              <h3 className="font-bold text-white">Post an auction</h3>
              <p className="text-xs text-slate-400">24-hour auction · bids in the final 5 minutes extend the clock to 5 minutes</p>
            </div>
          </div>
          <form onSubmit={submitAuction} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-300" htmlFor="auction-item">Item</label>
              <div className="space-y-2">
                  <label className="relative block">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                      id="auction-item"
                      type="search"
                      autoComplete="off"
                      value={itemSearch}
                      onChange={(event) => {
                        setItemSearch(event.target.value);
                        setItemResultLimit(40);
                      }}
                      placeholder="Search saved items..."
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 py-3 pl-9 pr-3.5 text-sm text-white outline-none placeholder:text-slate-500 focus:border-emerald-400/60"
                    />
                  </label>
                  {selectedCatalogItem && (
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-400/25 bg-emerald-400/5 px-3 py-2">
                      <span className="truncate text-xs font-semibold text-emerald-200">Selected: {selectedCatalogItem.name}</span>
                      <button
                        type="button"
                        onClick={() => setSelectedItemId('')}
                        className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                        aria-label="Clear selected item"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  <div className="max-h-52 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/70">
                    {filteredItems.length === 0 ? (
                      <p className="px-3 py-4 text-center text-xs text-slate-500">
                        {data.items.length === 0 ? 'No saved items yet. Ask a Chief, General, or Guardian to add one from the Items tab.' : 'No items match your search.'}
                      </p>
                    ) : visibleItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedItemId(item.id)}
                        className={`flex w-full items-center gap-3 border-b border-slate-800/70 px-3 py-2 text-left last:border-b-0 hover:bg-slate-800/70 ${selectedItemId === item.id ? 'bg-emerald-400/10' : ''}`}
                      >
                        <AuctionItemImage
                          itemId={item.id}
                          imageCount={item.imageCount}
                          alt={item.name}
                          className="h-10 w-10 shrink-0 rounded-lg bg-slate-900"
                        />
                        <span title={item.name} className="min-w-0 flex-1 break-words text-xs font-medium leading-snug text-slate-200">{item.name}</span>
                        <span className="max-w-28 shrink-0 break-words text-right text-[10px] leading-snug text-slate-500">{item.requiredRoles.join(' / ') || 'Role not set'} · {item.bossType}</span>
                      </button>
                    ))}
                  </div>
                  {filteredItems.length > visibleItems.length && (
                    <button
                      type="button"
                      onClick={() => setItemResultLimit((limit) => limit + 40)}
                      className="w-full rounded-lg border border-slate-800 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800"
                    >
                      Show more ({filteredItems.length - visibleItems.length} remaining)
                    </button>
                  )}
              </div>
              {selectedCatalogItem && (
                <div className={`flex items-center gap-3 rounded-xl border p-2.5 ${
                  selectedItemRoleIsValid
                    ? 'border-emerald-400/20 bg-emerald-400/5'
                    : 'border-amber-400/25 bg-amber-400/5'
                }`}>
                  <AuctionItemImage
                    itemId={selectedItemId}
                    imageCount={selectedCatalogItem.imageCount}
                    alt="Saved item"
                    className="h-16 w-16 shrink-0 rounded-lg bg-slate-900 object-contain"
                  />
                  <div className="min-w-0">
                    <p className="break-words text-sm font-bold leading-snug text-white">{selectedCatalogItem.name}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">{selectedCatalogItem.requiredRoles.map((role) => <RoleBadge key={role} role={role} gameClass />)}<span className="text-xs text-slate-400">{selectedCatalogItem.bossType}</span></div>
                    {!selectedItemRoleIsValid && (
                      <p className="mt-1 text-xs leading-snug text-amber-200">
                        {selectedCatalogItem.requiredRoles.length
                          ? 'Choose supported subroles with icons in Items before posting.'
                          : 'A role must be set for this item in Items before it can be posted.'}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
            <button
              type="submit"
              disabled={saving || !selectedCatalogItem || !selectedItemRoleIsValid}
              className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold transition sm:col-span-2 ${
                saving || !selectedCatalogItem || !selectedItemRoleIsValid
                  ? 'cursor-not-allowed border border-slate-700 bg-slate-800 text-slate-400'
                  : 'bg-gradient-to-r from-emerald-500 to-green-500 text-white shadow-lg shadow-emerald-950/30 hover:from-emerald-400 hover:to-green-400'
              }`}
            >
              {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Gavel className="h-4 w-4" />}
              {saving ? 'Posting auction...' : !selectedCatalogItem ? 'Choose an item to post' : !selectedItemRoleIsValid ? 'Set item roles before posting' : 'Post 24-hour auction'}
            </button>
          </form>
        </section>
      )}

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
              <span><span className="block font-bold text-white">Auction follow-up</span><span className="mt-0.5 block text-[11px] font-normal text-slate-400">Confirm delivery or resolve auctions with no bids</span></span>
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
                      {auction.winner ? (
                        <p className="break-words text-xs leading-snug text-slate-400">Mail to <span className="font-semibold text-amber-200">{auction.winner.account || auction.winner.owner}</span></p>
                      ) : (
                        <p className="text-xs text-slate-400">No bids · choose what happens to this item</p>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {auction.canMarkDelivered && (
                      <button disabled={saving} onClick={() => void markDelivered(auction.id)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-green-600 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-emerald-950/30 hover:from-emerald-500 hover:to-green-500 disabled:opacity-50">
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

      {(wonAuctions.length > 0 || archiveLoaded) && (
        <section className="rounded-2xl border border-emerald-400/20 bg-slate-900/60 p-3 sm:p-4">
          <button
            type="button"
            onClick={() => setWonItemsOpen((open) => !open)}
            aria-expanded={wonItemsOpen}
            aria-controls="auction-won-items"
            className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-slate-800/60"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <Trophy className="h-4 w-4 shrink-0 text-emerald-300" />
              <span><span className="block font-bold text-white">Items you won</span><span className="mt-0.5 block text-[11px] font-normal text-slate-400">Your completed wins and mail status</span></span>
              <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs font-bold tabular-nums text-emerald-200">{wonAuctions.length}</span>
            </span>
            {wonItemsOpen
              ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" />
              : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
          </button>
          {wonItemsOpen && (
            <div id="auction-won-items" className="mt-3 space-y-3 border-t border-slate-800 pt-4">
              {wonAuctions.length === 0 && <p className="text-sm text-slate-400">No completed wins found in the loaded history.</p>}
              {wonAuctions.map((auction) => (
                <article key={auction.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-bold text-white">{auction.itemName}</p>
                    <p className="mt-1 text-[11px] text-slate-400">
                      {auction.deliveryStatus === 'done'
                        ? `Mailed · ${auction.bossType}`
                        : `Awaiting mail · ${auction.bossType}`}
                    </p>
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
            <div><h3 className="text-lg font-bold text-white">Browse auctions</h3><p className="text-xs text-slate-500">{auctionView === 'live' ? `${liveAuctions.length} live or finalizing` : `${allAuctions.length} total loaded`}</p><p className="mt-1 flex items-center gap-1.5 text-[10px] font-medium text-slate-500"><span className={`h-1.5 w-1.5 rounded-full ${syncing ? 'animate-pulse bg-indigo-300' : error || !lastSyncedAt ? 'bg-amber-300' : 'bg-emerald-400'}`} />{syncing ? 'Syncing automatically' : error || !lastSyncedAt ? 'Updates delayed — retrying automatically' : `Last checked ${new Date(lastSyncedAt).toLocaleTimeString()}`}</p></div>
            <div className="flex rounded-xl border border-slate-700 bg-slate-950 p-1" role="tablist" aria-label="Auction views">
              <button type="button" role="tab" aria-selected={auctionView === 'live'} onClick={() => setAuctionView('live')} className={`rounded-lg px-3 py-2 text-xs font-bold transition ${auctionView === 'live' ? 'bg-indigo-500 text-white shadow' : 'text-slate-400 hover:text-white'}`}>Live <span className="ml-1 tabular-nums opacity-75">{liveAuctions.length}</span></button>
              <button type="button" role="tab" aria-selected={auctionView === 'all'} onClick={() => setAuctionView('all')} className={`rounded-lg px-3 py-2 text-xs font-bold transition ${auctionView === 'all' ? 'bg-indigo-500 text-white shadow' : 'text-slate-400 hover:text-white'}`}>All history</button>
            </div>
          </div>
          <div className="flex min-w-0 gap-2">
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
          <p role="status" className="flex items-center gap-2 rounded-xl border border-indigo-400/20 bg-indigo-400/5 px-4 py-3 text-sm text-indigo-200"><LoaderCircle className="h-4 w-4 animate-spin" /> Loading full auction history…</p>
        )}
        {auctionView === 'all' && archiveLoaded && (
          <p role="status" className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3 text-xs text-slate-400">{allAuctions.length} auctions loaded{archiveCursor ? ' · More history is available below.' : ' · All available history loaded.'}</p>
        )}
        {auctionView === 'all' && archiveCursor && <button type="button" className="secondary-button w-full" disabled={archiveLoading} onClick={() => void loadFullAuctionHistory(true)}>{archiveLoading ? <LoaderCircle size={15} className="animate-spin" /> : <Clock3 size={15} />}Load older auctions</button>}
        {auctionView === 'all' && !archiveLoaded && !archiveLoading && error && (
          <button type="button" onClick={() => void loadFullAuctionHistory()} className="rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-left text-sm text-red-200">History did not load. Select here to retry.</button>
        )}

        {allAuctions.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 px-5 py-12 text-center">
            <Gavel className="mx-auto h-7 w-7 text-slate-600" />
            <p className="mt-3 text-sm text-slate-400">There are no auctions yet.</p>
          </div>
        ) : visibleAuctions.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 px-5 py-12 text-center">
            <Search className="mx-auto h-7 w-7 text-slate-600" />
            <p className="mt-3 text-sm text-slate-400">{auctionView === 'live' && liveAuctions.length === 0 ? 'There are no live auctions right now.' : 'No auctions match these filters.'}</p>
            {auctionView === 'live' && liveAuctions.length === 0 && <button type="button" onClick={() => setAuctionView('all')} className="mt-3 text-xs font-semibold text-indigo-300 hover:text-indigo-200">Browse auction history</button>}
          </div>
        ) : (
          <div className="grid w-full gap-4 xl:grid-cols-2">
            {visibleAuctions.map((auction) => {
              const isActive = auction.status === 'active' && !auction.biddingClosed && new Date(auction.endsAt).getTime() > now;
              const secondsLeft = Math.max(0, Math.floor((new Date(auction.endsAt).getTime() - now) / 1000));
              const endingSoon = isActive && secondsLeft <= 30;
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
                <article key={auction.id} className={`group overflow-hidden rounded-2xl border bg-slate-900/80 shadow-lg transition duration-300 hover:-translate-y-0.5 hover:shadow-2xl ${isActive ? 'border-emerald-400/25 shadow-emerald-950/20 hover:border-emerald-300/40 hover:shadow-emerald-950/30' : 'border-slate-800 shadow-black/15'}`}>
                  <header className="flex items-start justify-between gap-3 p-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-[11px] text-slate-500">Posted by {auction.createdBy} · {localTimeReady ? new Date(auction.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Local date and time'}</p>
                        <h4 className="mt-1 break-words text-lg font-black leading-tight text-white">{auction.itemName}</h4>
                      </div>
                    </div>
                    {isActive && (auction.canRemove || auction.canClose) && (
                      <div className="flex shrink-0 justify-end gap-2">
                        {auction.canClose && <button className="secondary-button !min-h-9 !px-2.5 !py-1.5 !text-[10px]" type="button" disabled={saving} onClick={() => void closeAuction(auction)}><Clock3 size={12} /> Close</button>}
                        {auction.canRemove && <button type="button" disabled={saving} onClick={() => void removeAuction(auction)} className="group/remove inline-flex h-9 w-9 items-center justify-center rounded-xl border border-rose-400/30 bg-gradient-to-br from-rose-500/20 via-rose-950/60 to-slate-950 text-rose-200 shadow-lg shadow-rose-950/25 transition duration-200 hover:-translate-y-0.5 hover:border-rose-300/70 hover:from-rose-500/40 hover:text-white hover:shadow-xl hover:shadow-rose-950/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/70 disabled:cursor-wait disabled:opacity-50" aria-label={`Remove ${auction.itemName} auction`} title="Remove auction"><X className="h-4 w-4 transition group-hover/remove:rotate-90" strokeWidth={2.5} /></button>}
                      </div>
                    )}
                  </header>

                  <div className="grid gap-4 px-4 pb-4 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                    <div className="order-2 relative aspect-square w-full overflow-hidden rounded-xl bg-slate-950/70 sm:order-1">
                      <AuctionItemImage itemId={auction.itemId} imageCount={auction.imageCount} alt={auction.itemName} className="absolute inset-0 h-full w-full max-w-none rounded-xl bg-slate-950/20 p-0" />
                    </div>
                    <div className="order-1 flex min-w-0 flex-col gap-3 sm:order-2 sm:pt-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-black tracking-wider ${isActive ? 'bg-emerald-300 text-emerald-950' : auction.status === 'settlement-failed' ? 'bg-red-400/10 text-red-300' : 'bg-slate-800 text-slate-300'}`}>{isActive && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-900" />}{isActive ? 'LIVE' : auction.status === 'settling' || auction.status === 'active' ? 'FINALIZING' : auction.status === 'settlement-failed' ? 'REVIEW' : 'ENDED'}</span>
                      {auctionRoles.map((role) => <RoleBadge key={role} role={role} gameClass />)}
                      <span className="rounded-full border border-slate-700 bg-slate-950/60 px-2 py-1 text-[10px] font-semibold text-slate-400">{auction.bossType}</span>
                      {isActive && <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-xs font-bold tabular-nums ${endingSoon ? 'animate-pulse border-rose-300/30 bg-rose-950/35 text-rose-200' : 'border-slate-700 bg-slate-950/60 text-slate-200'}`}><Clock3 className="h-3 w-3" />{formatRemaining(auction.endsAt, now)}</span>}
                      {!isActive && <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">{auction.status === 'settlement-failed' ? <ShieldAlert className="h-3.5 w-3.5 text-rose-300" /> : <Trophy className="h-3.5 w-3.5 text-amber-300" />}{auction.status === 'settlement-failed' ? 'Settlement needs review' : auction.status === 'completed' ? 'Auction closed' : 'Confirming auction result'}</span>}
                    </div>

                    <div className="@container min-w-0">
                      {auction.highBid ? (
                        <div className="relative grid gap-2 overflow-hidden rounded-xl border border-amber-300/20 bg-gradient-to-br from-amber-300/[0.12] via-amber-400/[0.04] to-slate-950/70 p-4 text-center shadow-inner shadow-amber-200/[0.03] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:text-left">
                          <div className="min-w-0">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{auction.status === 'completed' ? 'Winning toon' : isActive ? 'Leading toon' : 'Last leading bid'}</p>
                            <p className="mt-1 break-all text-lg font-bold leading-snug text-slate-100">{auction.highBid.account || auction.highBid.owner}</p>
                          </div>
                          <p aria-live="polite" className="text-4xl font-black tracking-tight tabular-nums text-amber-100 drop-shadow-[0_0_14px_rgba(251,191,36,0.18)] sm:text-right">{auction.highBid.amount.toLocaleString()} <span className="text-[10px] font-bold tracking-normal text-amber-300/70">DKP</span></p>
                        </div>
                      ) : (
                        <p className={`rounded-xl border p-3 text-center text-sm ${
                          isActive
                            ? 'border-slate-800 bg-slate-950/50 text-slate-400'
                            : 'border-slate-700 bg-slate-950/70 font-semibold text-slate-300'
                        }`}>
                          {isActive ? 'No bids yet' : auction.status === 'completed' ? 'Auction ended with no bids' : 'Confirming auction result...'}
                        </p>
                      )}
                      {isActive && auction.highBid?.isMine && (
                        <p className="mt-2 text-center text-xs font-semibold text-emerald-300">Your bid is leading.</p>
                      )}
                    </div>

                    <div className="space-y-3 border-t border-slate-800/80 pt-3">
                    {auction.status === 'completed' && !auction.highBid && auction.deliveryStatus === 'banked' && (
                      <p className="text-xs text-amber-200">Mailed to bank by {auction.deliveredBy}</p>
                    )}
                    {auction.status === 'completed' && !auction.highBid && auction.deliveryStatus === 'reposted' && (
                      <p className="text-xs text-indigo-200">Reposted by {auction.deliveredBy}</p>
                    )}

                    {isActive && (
                      <div className="mt-auto space-y-3 rounded-xl border border-indigo-300/20 bg-[linear-gradient(135deg,rgba(99,102,241,0.11),rgba(15,23,42,0.55)_52%,rgba(2,6,23,0.8))] p-3 shadow-inner shadow-indigo-300/[0.04]">
                        {auction.highBid && !auction.highBid.isMine && (
                          <p className="text-center text-xs font-semibold text-amber-200">Someone else is leading. Bid above {auction.highBid.amount.toLocaleString()} DKP to take the lead.</p>
                        )}
                        {eligibleToons.length > 0 && data.canBidWeekly ? (
                          <>
                            {eligibleToons.length === 1 ? (
                              <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5">
                                <div className="min-w-0"><p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Bidding as</p><p className="truncate text-sm font-bold text-white">{eligibleToons[0].account || eligibleToons[0].owner} <span className="font-normal text-slate-400">· {eligibleToons[0].subClass}</span></p></div>
                                <p className="shrink-0 text-right"><span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500">Max total</span><span className="text-sm font-black tabular-nums text-emerald-200">{toonMaximumBid(eligibleToons[0]).toLocaleString()} DKP</span></p>
                              </div>
                            ) : (
                              <label className="block space-y-1.5">
                                <span className="text-[11px] font-semibold text-slate-400">Choose toon and role</span>
                                <select aria-label="Choose toon and role to bid with" value={selectedRow ?? ''} onChange={(event) => setSelectedToons((current) => ({ ...current, [auction.id]: Number(event.target.value) }))} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-indigo-400/60">
                                  {eligibleToons.map((toon) => <option key={toon.rowIndex} value={toon.rowIndex}>{toon.account || toon.owner} · {toon.subClass} · Max {toonMaximumBid(toon).toLocaleString()} DKP</option>)}
                                </select>
                              </label>
                            )}
                            <div className="grid grid-cols-[1fr_auto] gap-2">
                              <label className="min-w-0">
                                <span className="sr-only">Bid amount</span>
                                <input aria-label={`Bid on ${auction.itemName}`} type="number" min={minimumBid} max={maxBid} step={1} value={bidAmounts[auction.id] ?? ''} onChange={(event) => setBidAmounts((current) => ({ ...current, [auction.id]: event.target.value }))} placeholder="Enter bid amount" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-white outline-none placeholder:text-slate-500 focus:border-indigo-400/60" />
                              </label>
                              <button disabled={saving || syncing || !lastSyncedAt || !Number.isSafeInteger(Number(bidAmounts[auction.id])) || !selectedToon || maxBid < minimumBid || Number(bidAmounts[auction.id]) < minimumBid || Number(bidAmounts[auction.id]) > maxBid} onClick={() => void submitBid(auction)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-950/40 transition hover:from-indigo-400 hover:to-violet-400 hover:shadow-indigo-900/50 disabled:cursor-not-allowed disabled:opacity-45">
                                <Gavel className="h-4 w-4" /> {Number(bidAmounts[auction.id]) >= minimumBid ? `Bid ${Number(bidAmounts[auction.id]).toLocaleString()}` : 'Place bid'}
                              </button>
                            </div>
                          </>
                        ) : (
                          <p className="rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2.5 text-xs text-slate-400">
                            {data.canBidWeekly ? (auctionRoles.some((role) => normalizeAuctionRole(role) === 'everyone') ? 'Link a toon with valid DKP to bid on this item.' : `You need a linked ${auctionRoles.join(' or ')} toon to bid.`) : `You need ${data.weeklyMinimum} weekly DKP across your toons to bid.`}
                          </p>
                        )}
                      </div>
                    )}

                    {auction.status === 'settlement-failed' && auction.settlementError && (
                      <p role="alert" className="flex gap-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-300"><ShieldAlert className="h-4 w-4 shrink-0" />{auction.settlementError}</p>
                    )}
                    {auction.canRetrySettlement && <button type="button" className="secondary-button" disabled={saving} onClick={() => void retrySettlement(auction)}><RefreshCw size={13} />Retry settlement</button>}
                    {!isActive && auction.status === 'completed' && auction.winner && (
                      <p className="flex items-start gap-2 break-words text-xs leading-snug text-emerald-300">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>Winner: <span className="break-all">{auction.winner.account || auction.winner.owner}</span>
                        </span>
                      </p>
                    )}
                    </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
