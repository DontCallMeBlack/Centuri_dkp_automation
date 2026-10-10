'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock3, Filter, Gavel, ImageOff, LoaderCircle, PackageCheck, Plus, RefreshCw, Search, ShieldAlert, Sparkles, Trophy, X } from 'lucide-react';
import { normalizeAuctionRole } from '@/lib/auctionRules';

interface AuctionToon {
  rowIndex: number;
  owner: string;
  account: string;
  subClass: string;
  weeklyEarned: number;
  available: number;
  heldPoints: number;
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
  status: 'active' | 'settling' | 'completed' | 'settlement-failed';
  highBid: AuctionBid | null;
  winner: AuctionBid | null;
  deliveryStatus: 'pending' | 'done' | 'not-required' | 'banked' | 'reposted';
  deliveredBy: string | null;
  deliveredAt: string | null;
  settlementError: string | null;
  canResolveNoBid: boolean;
}

interface AuctionData {
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
  return `${hours}h ${minutes}m ${remainingSeconds}s`;
}

function AuctionItemImage({
  itemId,
  imageCount,
  alt,
  className,
}: {
  itemId: string;
  imageCount: number;
  alt: string;
  className: string;
}) {
  const [imageIndex, setImageIndex] = useState(0);
  const [imageUrl, setImageUrl] = useState('');
  const [imageError, setImageError] = useState('');
  const [imageVisible, setImageVisible] = useState(false);
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const imageTotal = Math.max(1, imageCount);

  useEffect(() => {
    const container = imageContainerRef.current;
    if (!container) return;

    setImageVisible(false);
    if (!('IntersectionObserver' in window)) {
      setImageVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setImageVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [itemId]);

  useEffect(() => {
    if (!imageVisible) return;
    let active = true;
    let objectUrl = '';

    const loadImage = async () => {
      try {
        setImageError('');
        const response = await fetch(`/api/auction/image?id=${encodeURIComponent(itemId)}&index=${imageIndex}`, {
          credentials: 'same-origin',
        });
        if (!response.ok) {
          throw new Error(`Image request failed (${response.status})`);
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.startsWith('image/')) {
          throw new Error('Image endpoint returned a non-image response');
        }

        const imageBlob = await response.blob();
        if (imageBlob.size === 0) throw new Error('Stored image is empty');

        objectUrl = URL.createObjectURL(imageBlob);
        const image = new Image();
        image.onload = () => {
          if (active) setImageUrl(objectUrl);
        };
        image.onerror = () => {
          if (active) setImageError('Stored image could not be decoded');
        };
        image.src = objectUrl;
      } catch (loadError) {
        if (active) {
          setImageError(loadError instanceof Error ? loadError.message : 'Unable to load item image');
        }
      }
    };

    setImageUrl('');
    void loadImage();

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [itemId, imageIndex, imageVisible]);

  if (imageError) {
    return (
      <div ref={imageContainerRef} role="img" aria-label={`${alt}: ${imageError}`} title={imageError} className={`${className} relative flex flex-col items-center justify-center gap-1 overflow-hidden p-2 text-center text-[9px] text-rose-300`}>
        <ImageOff className="h-4 w-4 shrink-0" />
        <span>Image unavailable</span>
        {imageTotal > 1 && (
          <ImageNavigation
            imageIndex={imageIndex}
            imageTotal={imageTotal}
            setImageIndex={setImageIndex}
          />
        )}
      </div>
    );
  }

  if (!imageUrl) {
    return (
      <div ref={imageContainerRef} aria-label={imageVisible ? `Loading ${alt}` : alt} className={`${className} relative flex items-center justify-center overflow-hidden`}>
        {imageVisible && <LoaderCircle className="h-4 w-4 animate-spin text-slate-500" />}
        {imageTotal > 1 && (
          <ImageNavigation
            imageIndex={imageIndex}
            imageTotal={imageTotal}
            setImageIndex={setImageIndex}
          />
        )}
      </div>
    );
  }

  return (
    <div ref={imageContainerRef} className={`${className} relative overflow-hidden`}>
      <img src={imageUrl} alt={`${alt} image ${imageIndex + 1}`} className="h-full w-full object-contain" />
      {imageTotal > 1 && (
        <ImageNavigation
          imageIndex={imageIndex}
          imageTotal={imageTotal}
          setImageIndex={setImageIndex}
        />
      )}
    </div>
  );
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

export default function AuctionHousePanel() {
  const [data, setData] = useState<AuctionData | null>(null);
  const [loading, setLoading] = useState(true);
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
  const [selectedToons, setSelectedToons] = useState<Record<string, number>>({});
  const [bidAmounts, setBidAmounts] = useState<Record<string, string>>({});
  const router = useRouter();

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const response = await fetch('/api/auction', { cache: 'no-store' });
        const result = await response.json();
        if (response.status === 401) {
          router.push('/login');
          return;
        }
        if (!response.ok) throw new Error(result.error || 'Unable to load auctions');
        if (mounted) {
          setError('');
          setData(result);
        }
      } catch (loadError) {
        if (mounted) setError(loadError instanceof Error ? loadError.message : 'Unable to load auctions');
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void load();
    const refreshTimer = window.setInterval(() => void load(), 30000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted = false;
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, [router]);

  const refresh = async () => {
    const response = await fetch('/api/auction', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to refresh auctions');
    setError('');
    setData(result);
  };

  const loadFullAuctionHistory = async () => {
    setArchiveLoading(true);
    setError('');
    try {
      const response = await fetch('/api/auction?includeArchive=1', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to load full auction history');
      setArchiveAuctions(result.auctions);
      setArchiveLoaded(true);
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : 'Unable to load full auction history');
    } finally {
      setArchiveLoading(false);
    }
  };

  const submitAuction = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/auction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create-auction', itemId: selectedItemId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to post auction');
      setNotice('Auction posted. It will close in 24 hours; bids in the final 2 minutes extend the timer.');
      setPostFormOpen(false);
      await refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to post auction');
    } finally {
      setSaving(false);
    }
  };

  const submitBid = async (auction: Auction) => {
    const rowIndex = selectedToons[auction.id];
    const amount = Number(bidAmounts[auction.id]);
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/auction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bid', auctionId: auction.id, rowIndex, amount }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to place bid');
      setNotice(result.message);
      await refresh();
    } catch (bidError) {
      setError(bidError instanceof Error ? bidError.message : 'Unable to place bid');
      try {
        await refresh();
      } catch (refreshError) {
        setError(refreshError instanceof Error ? refreshError.message : 'Unable to refresh auctions');
      }
    } finally {
      setSaving(false);
    }
  };

  const markDelivered = async (auctionId: string) => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/auction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark-delivered', auctionId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to update delivery task');
      setNotice(result.message || 'Item marked mailed.');
      await refresh();
    } catch (deliveryError) {
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
    setNotice('');
    try {
      const response = await fetch('/api/auction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove-auction', auctionId: auction.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to remove auction');
      setNotice(result.message);
      await refresh();
    } catch (removeError) {
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
    setNotice('');
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
      await refresh();
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : 'Unable to resolve auction');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-400"><LoaderCircle className="h-4 w-4 animate-spin" /> Loading auction house...</div>;
  }

  if (!data) {
    return <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
      <p role="alert">{error || 'Unable to load the auction house.'}</p>
      <button onClick={() => window.location.reload()} className="mt-4 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold hover:bg-slate-800">Retry</button>
    </section>;
  }

  const filteredItems = data.items.filter((item) =>
    item.name.toLowerCase().includes(itemSearch.trim().toLowerCase()),
  );
  const visibleItems = filteredItems.slice(0, itemResultLimit);
  const selectedCatalogItem = data.items.find((item) => item.id === selectedItemId);
  const selectedItemRoleIsValid = Boolean(
    Boolean(selectedCatalogItem?.requiredRoles.length) &&
    selectedCatalogItem!.requiredRoles.every((requiredRole) => data.roles.some((role) =>
      normalizeAuctionRole(role) === normalizeAuctionRole(requiredRole),
    )),
  );
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
    (!auctionRoleFilter || (auction.requiredRoles?.length ? auction.requiredRoles : [auction.requiredRole ?? ''])
      .some((role) => normalizeAuctionRole(role) === normalizeAuctionRole(auctionRoleFilter))) &&
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

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-2xl border border-amber-400/20 bg-gradient-to-br from-amber-950/60 via-slate-900 to-slate-950 px-4 py-3 shadow-lg shadow-amber-950/15 sm:px-5">
        <div className="pointer-events-none absolute -right-12 -top-20 h-48 w-48 rounded-full bg-amber-400/10 blur-3xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-400/10 text-amber-300">
              <Gavel className="h-4 w-4" />
            </div>
            <h2 className="truncate text-lg font-black text-white">Auction House</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="rounded-lg border border-slate-700/80 bg-slate-950/40 px-2.5 py-1.5 text-[11px] font-semibold text-slate-300">
              Weekly DKP <span className="ml-1 text-white">{data.weeklyEarnedTotal.toLocaleString()}</span>
            </p>
            {data.manager && (
              <button
                type="button"
                onClick={() => setPostFormOpen((open) => !open)}
                aria-expanded={postFormOpen}
                aria-controls="auction-post-form"
                aria-label={postFormOpen ? 'Close auction post form' : 'Post an auction'}
                className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-2.5 text-[11px] font-bold text-white shadow-md shadow-emerald-950/30 transition hover:bg-emerald-400"
              >
                {postFormOpen ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                <span>{postFormOpen ? 'Close' : 'Post'}</span>
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
      {notice && <p role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>}
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
              <p className="text-xs text-slate-400">Chief, General, and Guardian access · closes 24 hours after posting</p>
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
                    <p className="mt-1 break-words text-xs text-slate-400">
                      {selectedCatalogItem.requiredRoles.join(' / ') || 'Role not set'} · {selectedCatalogItem.bossType}
                    </p>
                    {!selectedItemRoleIsValid && (
                      <p className="mt-1 text-xs leading-snug text-amber-200">
                        {selectedCatalogItem.requiredRoles.length
                          ? 'This saved role is not on the current roster. Update it in Items before posting.'
                          : 'A role must be set for this item in Items before it can be posted.'}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
            <p className="self-center text-xs text-slate-500">The saved item’s allowed roles and boss type are used automatically for the auction.</p>
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
            className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-slate-800/60"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <PackageCheck className="h-4 w-4 shrink-0 text-amber-300" />
              <span className="font-bold text-white">Auction TODO list</span>
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
                        <p className="break-words text-xs leading-snug text-slate-400">Mail to <span className="font-semibold text-amber-200">{auction.winner.nickname}</span> · {auction.winner.account || auction.winner.owner} · {auction.winner.amount.toLocaleString()} DKP</p>
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

      {wonAuctions.length > 0 && (
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
              <span className="font-bold text-white">Items you won</span>
              <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs font-bold tabular-nums text-emerald-200">{wonAuctions.length}</span>
            </span>
            {wonItemsOpen
              ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" />
              : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
          </button>
          {wonItemsOpen && (
            <div id="auction-won-items" className="mt-3 space-y-3 border-t border-slate-800 pt-4">
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

      <section className="space-y-3">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0">
            <h3 className="text-lg font-bold text-white">Auctions</h3>
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
            <button onClick={() => void refresh().catch((refreshError: unknown) => setError(refreshError instanceof Error ? refreshError.message : 'Unable to refresh auctions'))} aria-label="Refresh auctions" className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800"><RefreshCw className="h-4 w-4" /></button>
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
          <button
            type="button"
            disabled={archiveLoaded || archiveLoading}
            onClick={() => void loadFullAuctionHistory()}
            className="inline-flex items-center gap-2 text-left text-xs font-semibold text-indigo-300 hover:text-indigo-200 disabled:cursor-default disabled:text-slate-500 sm:col-span-3"
          >
            {archiveLoading && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
            {archiveLoaded ? 'Full auction history loaded' : 'Load full auction history for filtering'}
          </button>
        </div>}

        {allAuctions.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 px-5 py-12 text-center">
            <Gavel className="mx-auto h-7 w-7 text-slate-600" />
            <p className="mt-3 text-sm text-slate-400">There are no auctions yet.</p>
          </div>
        ) : filteredAuctions.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 px-5 py-12 text-center">
            <Search className="mx-auto h-7 w-7 text-slate-600" />
            <p className="mt-3 text-sm text-slate-400">No auctions match these filters.</p>
          </div>
        ) : (
          <div className="mx-auto grid w-full max-w-2xl gap-5">
            {filteredAuctions.map((auction) => {
              const isActive = auction.status === 'active' && new Date(auction.endsAt).getTime() > now;
              const auctionRoles = auction.requiredRoles?.length ? auction.requiredRoles : [auction.requiredRole ?? ''];
              const eligibleToons = data.toons.filter((toon) =>
                auctionRoles.some((role) => normalizeAuctionRole(toon.subClass) === normalizeAuctionRole(role)),
              );
              const selectedRow = selectedToons[auction.id] ?? eligibleToons[0]?.rowIndex;
              const selectedToon = eligibleToons.find((toon) => toon.rowIndex === selectedRow);
              const currentBidCredit = auction.highBid?.isMine && auction.highBid.rowIndex === selectedRow
                ? auction.highBid.amount
                : 0;
              const maxBid = selectedToon
                ? Math.max(0, selectedToon.available - selectedToon.heldPoints + currentBidCredit)
                : 0;
              const minimumBid = (auction.highBid?.amount ?? 0) + 1;
              const roleStyle = roleStyles[normalizeAuctionRole(auctionRoles[0] ?? '')] ?? 'border-slate-700 bg-slate-800 text-slate-300';

              return (
                <article key={auction.id} className={`overflow-hidden rounded-3xl border bg-slate-900/70 shadow-xl shadow-black/20 ${isActive ? 'border-slate-700/80' : 'border-slate-800'}`}>
                  <header className="flex items-start gap-3 p-4 sm:p-5">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-indigo-400/30 bg-gradient-to-br from-indigo-500/20 to-violet-500/20 text-sm font-black uppercase text-indigo-200">
                        {auction.createdBy.trim().charAt(0) || 'C'}
                      </div>
                      <div className="min-w-0">
                        <p className="break-all text-sm font-bold leading-snug text-white">{auction.createdBy}</p>
                        <p className="mt-0.5 break-words text-[11px] leading-snug text-slate-500">
                          Posted {new Date(auction.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </header>

                  <div className="flex justify-center border-y border-slate-800 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-800/70 via-slate-950 to-black px-3 py-4 sm:px-6 sm:py-6">
                    <AuctionItemImage
                      itemId={auction.itemId}
                      imageCount={auction.imageCount}
                      alt={auction.itemName}
                      className="mx-auto aspect-square w-full max-w-[34rem] rounded-2xl border border-white/5 bg-slate-950/40 p-3 sm:p-5"
                    />
                  </div>

                  <div className="space-y-4 p-4 sm:p-5">
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${isActive ? 'bg-emerald-400/10 text-emerald-300' : auction.status === 'settlement-failed' ? 'bg-red-400/10 text-red-300' : 'bg-slate-800 text-slate-300'}`}>
                        {isActive ? 'Live' : auction.status === 'settling' ? 'Settling' : auction.status === 'settlement-failed' ? 'Needs review' : 'Ended'}
                      </span>
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold capitalize ${roleStyle}`}>{auctionRoles.join(' / ')}</span>
                      <span className="rounded-full border border-slate-700 bg-slate-800/70 px-2.5 py-1 text-[10px] font-semibold text-slate-300">{auction.bossType}</span>
                      <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                        {isActive ? <Clock3 className="h-3.5 w-3.5 text-emerald-300" /> : <Trophy className="h-3.5 w-3.5 text-amber-300" />}
                        {isActive
                          ? <>Ends in <strong className="font-mono text-slate-200">{formatRemaining(auction.endsAt, now)}</strong></>
                          : auction.status === 'settlement-failed' ? 'Settlement needs review' : 'Auction closed'}
                      </span>
                    </div>

                    <div className="@container min-w-0">
                      <h4 className="w-full whitespace-nowrap text-center text-[clamp(0.75rem,4cqi,1.5rem)] font-black leading-snug text-white">{auction.itemName}</h4>
                      {auction.highBid ? (
                        <div className="mt-4 grid gap-2 rounded-2xl border border-amber-400/15 bg-gradient-to-br from-amber-400/10 to-amber-400/[0.02] p-4 text-center sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:text-left">
                          <div className="min-w-0">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{auction.status === 'completed' ? 'Winning bid' : 'Leading bid'}</p>
                            <p className="mt-1 break-all text-sm font-bold leading-snug text-slate-100">{auction.highBid.nickname}</p>
                            <p className="mt-0.5 break-all text-xs leading-snug text-slate-400">Toon: {auction.highBid.account || auction.highBid.owner}</p>
                          </div>
                          <p className="text-2xl font-black tabular-nums text-amber-200 sm:text-right">{auction.highBid.amount.toLocaleString()} <span className="text-[10px] font-bold text-amber-400/70">DKP</span></p>
                        </div>
                      ) : (
                        <p className={`mt-4 rounded-2xl border p-3 text-center text-sm ${
                          isActive
                            ? 'border-slate-800 bg-slate-950/50 text-slate-400'
                            : 'border-slate-700 bg-slate-950/70 font-semibold text-slate-300'
                        }`}>
                          {isActive ? 'No bids yet · starting bid 1 DKP' : 'Auction ended with no bids'}
                        </p>
                      )}
                    </div>

                    <div className="space-y-3 border-t border-slate-800/80 pt-4">
                    {isActive && auction.canRemove && (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void removeAuction(auction)}
                        className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
                      >
                        <X className="h-3.5 w-3.5" /> Remove auction
                      </button>
                    )}
                    {auction.status === 'completed' && !auction.highBid && auction.deliveryStatus === 'banked' && (
                      <p className="text-xs text-amber-200">Mailed to bank by {auction.deliveredBy}</p>
                    )}
                    {auction.status === 'completed' && !auction.highBid && auction.deliveryStatus === 'reposted' && (
                      <p className="text-xs text-indigo-200">Reposted by {auction.deliveredBy}</p>
                    )}

                    {isActive && (
                      <div className="space-y-3">
                        {eligibleToons.length > 0 && data.canBidWeekly ? (
                          <>
                            <label className="block space-y-1.5">
                              <span className="text-[11px] font-semibold text-slate-400">Bid from your matching toon</span>
                              <select value={selectedRow ?? ''} onChange={(event) => setSelectedToons((current) => ({ ...current, [auction.id]: Number(event.target.value) }))} className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-xs text-white outline-none focus:border-indigo-400/60">
                                {eligibleToons.map((toon) => <option key={toon.rowIndex} value={toon.rowIndex}>{toon.account || toon.owner} · {toon.available - toon.heldPoints} DKP free</option>)}
                              </select>
                            </label>
                            <div className="grid grid-cols-[1fr_auto] gap-2">
                              <label className="min-w-0">
                                <span className="sr-only">Bid amount</span>
                                <input type="number" min={minimumBid} max={maxBid} step={1} value={bidAmounts[auction.id] ?? ''} onChange={(event) => setBidAmounts((current) => ({ ...current, [auction.id]: event.target.value }))} placeholder={`${minimumBid}–${maxBid} DKP`} className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-500 focus:border-indigo-400/60" />
                              </label>
                              <button disabled={saving || !selectedToon || maxBid < minimumBid} onClick={() => void submitBid(auction)} className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-45">
                                <Gavel className="h-3.5 w-3.5" /> Bid
                              </button>
                            </div>
                            <p className="text-[10px] text-slate-500">This toon has {maxBid.toLocaleString()} DKP free. A bid must be at least {minimumBid.toLocaleString()} DKP.</p>
                          </>
                        ) : (
                          <p className="rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2.5 text-xs text-slate-400">
                            {data.canBidWeekly ? `You need a linked ${auctionRoles.join(' or ')} toon to bid.` : `You need ${data.weeklyMinimum} weekly DKP across your toons to bid.`}
                          </p>
                        )}
                      </div>
                    )}

                    {auction.status === 'settlement-failed' && auction.settlementError && (
                      <p role="alert" className="flex gap-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-300"><ShieldAlert className="h-4 w-4 shrink-0" />{auction.settlementError}</p>
                    )}
                    {!isActive && auction.status === 'completed' && auction.winner && (
                      <p className="flex items-start gap-2 break-words text-xs leading-snug text-emerald-300">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>Winner: <span className="break-all">{auction.winner.nickname} · {auction.winner.account || auction.winner.owner}</span>
                        {auction.deliveryStatus === 'done' && <span className="text-slate-500">· mailed by {auction.deliveredBy}</span>}
                        </span>
                      </p>
                    )}
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
