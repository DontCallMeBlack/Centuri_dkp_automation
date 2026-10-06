'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronLeft, ChevronRight, Clock3, Gavel, ImageOff, ImagePlus, LoaderCircle, PackageCheck, Plus, RefreshCw, Search, ShieldAlert, Sparkles, Trophy, X } from 'lucide-react';
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
  requiredRole: string;
  createdBy: string;
  canRemove: boolean;
  createdAt: string;
  endsAt: string;
  status: 'active' | 'settling' | 'completed' | 'settlement-failed';
  highBid: AuctionBid | null;
  winner: AuctionBid | null;
  deliveryStatus: 'pending' | 'done' | 'not-required';
  deliveredBy: string | null;
  deliveredAt: string | null;
  settlementError: string | null;
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
  const imageTotal = Math.max(1, imageCount);

  useEffect(() => {
    let active = true;
    let objectUrl = '';

    const loadImage = async () => {
      try {
        setImageError('');
        const response = await fetch(`/api/auction/image?id=${encodeURIComponent(itemId)}&index=${imageIndex}`, {
          credentials: 'same-origin',
          cache: 'no-store',
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
  }, [itemId, imageIndex]);

  if (imageError) {
    return (
      <div role="img" aria-label={`${alt}: ${imageError}`} title={imageError} className={`${className} relative flex flex-col items-center justify-center gap-1 overflow-hidden p-2 text-center text-[9px] text-rose-300`}>
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
      <div aria-label={`Loading ${alt}`} className={`${className} relative flex items-center justify-center overflow-hidden`}>
        <LoaderCircle className="h-4 w-4 animate-spin text-slate-500" />
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
    <div className={`${className} relative overflow-hidden`}>
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
  const [newItemMode, setNewItemMode] = useState(false);
  const [postFormOpen, setPostFormOpen] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [itemName, setItemName] = useState('');
  const [requiredRole, setRequiredRole] = useState('');
  const [imageFiles, setImageFiles] = useState<File[]>([]);
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
          setRequiredRole((current) =>
            result.roles.find((role: string) => normalizeAuctionRole(role) === normalizeAuctionRole(current))
              ?? result.roles[0]
              ?? '',
          );
        }
      } catch (loadError) {
        if (mounted) setError(loadError instanceof Error ? loadError.message : 'Unable to load auctions');
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void load();
    const refreshTimer = window.setInterval(() => void load(), 15000);
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
    setRequiredRole((current: string) =>
      result.roles.find((role: string) => normalizeAuctionRole(role) === normalizeAuctionRole(current))
        ?? result.roles[0]
        ?? '',
    );
    setData(result);
  };

  const submitAuction = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const form = new FormData();
      form.set('action', 'create-auction');
      form.set('requiredRole', requiredRole);
      if (newItemMode) {
        if (imageFiles.length === 0) throw new Error('Upload at least one image for the new item.');
        form.set('itemName', itemName);
        for (const file of imageFiles) form.append('images', file);
      } else {
        form.set('itemId', selectedItemId);
      }
      const response = await fetch('/api/auction', { method: 'POST', body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to post auction');
      setNotice('Auction posted. It will close in 2 minutes; bids in the final 2 minutes extend the timer.');
      setNewItemMode(false);
      setItemName('');
      setImageFiles([]);
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
      setNotice('Winner delivery marked done.');
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

  if (loading) {
    return <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-400"><LoaderCircle className="h-4 w-4 animate-spin" /> Loading auction house...</div>;
  }

  if (!data) {
    return <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
      <p role="alert">{error || 'Unable to load the auction house.'}</p>
      <button onClick={() => window.location.reload()} className="mt-4 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold hover:bg-slate-800">Retry</button>
    </section>;
  }

  const activeAuctions = data.auctions.filter((auction) => auction.status === 'active');
  const filteredItems = data.items.filter((item) =>
    item.name.toLowerCase().includes(itemSearch.trim().toLowerCase()),
  );
  const selectedCatalogItem = data.items.find((item) => item.id === selectedItemId);
  const deliveryTasks = data.auctions.filter((auction) =>
    auction.status === 'completed' && auction.deliveryStatus === 'pending' && auction.winner,
  );

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-3xl border border-amber-400/20 bg-gradient-to-br from-amber-950/70 via-slate-900 to-slate-950 p-5 shadow-xl shadow-amber-950/20 sm:p-7">
        <div className="pointer-events-none absolute -right-12 -top-20 h-64 w-64 rounded-full bg-amber-400/10 blur-3xl" />
        <div className="relative space-y-3">
          <div className="flex items-start justify-between gap-2 sm:items-center">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-amber-400/30 bg-amber-400/10 text-amber-300">
              <Gavel className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-300">Centuri marketplace</p>
              <h2 className="mt-1 text-xl font-black text-white sm:text-2xl">Auction House</h2>
              <p className="mt-1 text-sm text-slate-300">Winning bids reserve DKP on the bidding toon until the auction ends.</p>
            </div>
          </div>
          {data.manager && (
            <button
              type="button"
              onClick={() => setPostFormOpen((open) => !open)}
              aria-expanded={postFormOpen}
              aria-controls="auction-post-form"
              aria-label={postFormOpen ? 'Close auction post form' : 'Post an auction'}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-sm font-bold text-white shadow-lg shadow-emerald-950/30 transition hover:bg-emerald-400 sm:h-auto sm:w-auto sm:gap-2 sm:px-4 sm:py-3"
            >
              {postFormOpen ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              <span className="hidden sm:inline">{postFormOpen ? 'Close form' : 'Post an auction'}</span>
            </button>
          )}
          </div>
          <div className="w-fit rounded-xl border border-slate-700/80 bg-slate-950/40 px-3 py-2 text-sm sm:px-4 sm:py-3">
            <p className="text-xs text-slate-400">Weekly DKP · all your linked toons</p>
            <p className="mt-1 font-bold text-white">{data.weeklyEarnedTotal.toLocaleString()} <span className="font-medium text-slate-400">/ {data.weeklyMinimum.toLocaleString()} required</span></p>
          </div>
        </div>
        <div className="relative mt-4 flex flex-wrap gap-2 text-[11px] text-slate-300">
          <span className="rounded-full border border-slate-700 bg-slate-950/40 px-3 py-1.5">2-minute auctions</span>
          <span className="rounded-full border border-slate-700 bg-slate-950/40 px-3 py-1.5">2-minute anti-snipe extension</span>
          <span className="rounded-full border border-slate-700 bg-slate-950/40 px-3 py-1.5">Held DKP is released when outbid</span>
        </div>
      </section>

      {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>}

      {data.manager && postFormOpen && (
        <section id="auction-post-form" className="rounded-2xl border border-emerald-400/20 bg-slate-900/60 p-5 shadow-lg sm:p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-400/20 bg-emerald-400/10 text-emerald-300"><Sparkles className="h-4 w-4" /></div>
            <div>
              <h3 className="font-bold text-white">Post an auction</h3>
              <p className="text-xs text-slate-400">Chief, General, and Guardian access · closes 2 minutes after posting</p>
            </div>
          </div>
          <form onSubmit={submitAuction} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-300" htmlFor="auction-item">Item</label>
              {newItemMode ? (
                <>
                  <input id="auction-item" required maxLength={120} value={itemName} onChange={(event) => setItemName(event.target.value)} placeholder="Full item name" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-3 text-sm text-white outline-none focus:border-emerald-400/60" />
                  <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-slate-700 bg-slate-950/50 px-3.5 py-3 text-sm text-slate-300 hover:border-emerald-400/40">
                    <ImagePlus className="h-4 w-4 shrink-0 text-emerald-300" />
                    <span className="min-w-0 truncate">{imageFiles.length > 0 ? `${imageFiles.length} image${imageFiles.length === 1 ? '' : 's'} selected` : 'Upload item images (PNG, JPEG, WebP · max 4 MB each)'}</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      onChange={(event) => setImageFiles(Array.from(event.target.files ?? []))}
                      className="sr-only"
                      required
                    />
                  </label>
                  {imageFiles.length > 0 && (
                    <ul className="space-y-1 text-[11px] text-slate-400">
                      {imageFiles.map((file) => <li key={`${file.name}-${file.lastModified}`}>{file.name}</li>)}
                    </ul>
                  )}
                </>
              ) : (
                <div className="space-y-2">
                  <label className="relative block">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                      id="auction-item"
                      type="search"
                      autoComplete="off"
                      value={itemSearch}
                      onChange={(event) => setItemSearch(event.target.value)}
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
                        {data.items.length === 0 ? 'No saved items yet. Add a new item below.' : 'No items match your search.'}
                      </p>
                    ) : filteredItems.map((item) => (
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
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-200">{item.name}</span>
                        <span className="shrink-0 text-[10px] text-slate-500">{item.imageCount} img</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button type="button" onClick={() => setNewItemMode((mode) => !mode)} className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-300 hover:text-emerald-200">
                {newItemMode ? 'Choose an existing item' : <><Plus className="h-3 w-3" /> Add a new item and image</>}
              </button>
              {!newItemMode && selectedCatalogItem && (
                <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-2.5">
                  <AuctionItemImage
                    itemId={selectedItemId}
                    imageCount={selectedCatalogItem.imageCount}
                    alt="Saved item"
                    className="h-16 w-16 shrink-0 rounded-lg bg-slate-900 object-contain"
                  />
                  <span className="text-xs text-slate-400">Saved item image</span>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-300" htmlFor="auction-role">Required toon role</label>
              <select id="auction-role" value={requiredRole} onChange={(event) => setRequiredRole(event.target.value)} disabled={data.roles.length === 0} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-3 text-sm capitalize text-white outline-none focus:border-emerald-400/60 disabled:opacity-50">
                {data.roles.length === 0
                  ? <option value="">No roles found in the sheet</option>
                  : data.roles.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              <p className="text-xs text-slate-500">Roles come directly from the Google Sheets roster. Only a linked toon with the selected role can bid.</p>
            </div>
            <button type="submit" disabled={saving || !requiredRole || (!newItemMode && !selectedItemId)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-green-500 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-950/30 transition hover:from-emerald-400 hover:to-green-400 disabled:cursor-not-allowed disabled:opacity-50 sm:col-span-2">
              {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Gavel className="h-4 w-4" />} Post 2-minute auction
            </button>
          </form>
        </section>
      )}

      {data.manager && (
        <section className="rounded-2xl border border-amber-400/20 bg-slate-900/60 p-5 sm:p-6">
          <div className="mb-4 flex items-center gap-2">
            <PackageCheck className="h-4 w-4 text-amber-300" />
            <h3 className="font-bold text-white">Winner delivery tasks</h3>
            <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[10px] font-bold text-amber-200">{deliveryTasks.length}</span>
          </div>
          {deliveryTasks.length === 0 ? (
            <p className="rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-5 text-sm text-slate-400">No winners are waiting for an item to be mailed.</p>
          ) : (
            <div className="space-y-3">
              {deliveryTasks.map((auction) => (
                <article key={auction.id} className="flex flex-col justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 items-center gap-3">
                    <AuctionItemImage
                      itemId={auction.itemId}
                      imageCount={auction.imageCount}
                      alt={auction.itemName}
                      className="h-16 w-16 shrink-0 rounded-lg bg-slate-900 object-contain"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-white">{auction.itemName}</p>
                      <p className="text-xs text-slate-400">Mail to <span className="font-semibold text-amber-200">{auction.winner?.nickname}</span> · {auction.winner?.owner} · {auction.winner?.amount.toLocaleString()} DKP</p>
                    </div>
                  </div>
                  <button disabled={saving} onClick={() => void markDelivered(auction.id)} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-green-600 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-emerald-950/30 hover:from-emerald-500 hover:to-green-500 disabled:opacity-50">
                    <Check className="h-4 w-4" /> Mark mailed · Done
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-white">Auctions</h3>
            <p className="text-xs text-slate-400">Your bid limit is each toon’s available DKP minus its other active holds.</p>
          </div>
          <button onClick={() => void refresh().catch((refreshError: unknown) => setError(refreshError instanceof Error ? refreshError.message : 'Unable to refresh auctions'))} aria-label="Refresh auctions" className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800"><RefreshCw className="h-4 w-4" /></button>
        </div>

        {data.auctions.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 px-5 py-12 text-center">
            <Gavel className="mx-auto h-7 w-7 text-slate-600" />
            <p className="mt-3 text-sm text-slate-400">There are no auctions yet.</p>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {data.auctions.map((auction) => {
              const isActive = auction.status === 'active' && new Date(auction.endsAt).getTime() > now;
              const eligibleToons = data.toons.filter((toon) =>
                normalizeAuctionRole(toon.subClass) === normalizeAuctionRole(auction.requiredRole),
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
              const roleStyle = roleStyles[normalizeAuctionRole(auction.requiredRole)] ?? 'border-slate-700 bg-slate-800 text-slate-300';

              return (
                <article key={auction.id} className={`overflow-hidden rounded-2xl border bg-slate-900/60 shadow-lg ${isActive ? 'border-slate-700/80' : 'border-slate-800'}`}>
                  <div className="flex gap-4 p-4 sm:p-5">
                    <AuctionItemImage
                      itemId={auction.itemId}
                      imageCount={auction.imageCount}
                      alt={auction.itemName}
                      className="h-40 w-40 shrink-0 rounded-xl border border-slate-800 bg-slate-950 object-contain p-1 sm:h-52 sm:w-52"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h4 className="truncate text-base font-bold text-white">{auction.itemName}</h4>
                          <p className={`mt-1 inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold capitalize ${roleStyle}`}>{auction.requiredRole} only</p>
                        </div>
                        <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${isActive ? 'bg-emerald-400/10 text-emerald-300' : auction.status === 'settlement-failed' ? 'bg-red-400/10 text-red-300' : 'bg-slate-800 text-slate-300'}`}>
                          {isActive ? 'Live' : auction.status === 'settling' ? 'Settling' : auction.status === 'settlement-failed' ? 'Needs review' : 'Ended'}
                        </span>
                      </div>
                      <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
                        {isActive ? <Clock3 className="h-3.5 w-3.5 text-emerald-300" /> : <Trophy className="h-3.5 w-3.5 text-amber-300" />}
                        {isActive ? <span>Ends in <strong className="font-mono text-slate-200">{formatRemaining(auction.endsAt, now)}</strong></span> : <span>{auction.status === 'settlement-failed' ? 'Settlement could not be completed' : 'Auction closed'}</span>}
                      </div>
                      <p className="mt-2 text-[11px] text-slate-500">Posted by {auction.createdBy}</p>
                    </div>
                  </div>

                  <div className="space-y-3 border-t border-slate-800/80 bg-slate-950/30 p-4 sm:p-5">
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
                    {auction.highBid ? (
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{auction.status === 'completed' ? 'Winning bid' : 'Leading bid'}</p>
                          <p className="truncate text-xs text-slate-300">{auction.highBid.nickname} · {auction.highBid.owner}</p>
                        </div>
                        <p className="shrink-0 text-lg font-black text-amber-200">{auction.highBid.amount.toLocaleString()} <span className="text-[10px] font-bold text-amber-400/70">DKP</span></p>
                      </div>
                    ) : <p className="text-xs text-slate-400">No bids yet · starting bid 1 DKP</p>}

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
                            {data.canBidWeekly ? `You need a linked ${auction.requiredRole} toon to bid.` : `You need ${data.weeklyMinimum} weekly DKP across your toons to bid.`}
                          </p>
                        )}
                      </div>
                    )}

                    {auction.status === 'settlement-failed' && auction.settlementError && (
                      <p role="alert" className="flex gap-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-300"><ShieldAlert className="h-4 w-4 shrink-0" />{auction.settlementError}</p>
                    )}
                    {!isActive && auction.status === 'completed' && auction.winner && (
                      <p className="flex items-center gap-2 text-xs text-emerald-300">
                        <Check className="h-3.5 w-3.5" /> Winner: {auction.winner.nickname} · {auction.winner.owner}
                        {auction.deliveryStatus === 'done' && <span className="text-slate-500">· mailed by {auction.deliveredBy}</span>}
                      </p>
                    )}
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
