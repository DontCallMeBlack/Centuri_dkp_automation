'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SquareImageUpload, buildItemForm } from '@/components/AuctionItemUpload';
import EmptyState from '@/components/EmptyState';
import RoleBadge from '@/components/RoleBadge';
import ItemSubrolePicker from '@/components/ItemSubrolePicker';
import { resolveItemSubroles } from '@/lib/auctionRules';
import { ApiError, clearClientData, clientDataVersion, getData, invalidateData, peekData, rememberData } from '@/lib/client/api';
import { LoaderCircle, Save, Search, Trash2, Pencil, Plus } from 'lucide-react';
import AuctionItemCreateForm from '@/components/AuctionItemCreateForm';

interface CatalogItem {
  id: string;
  name: string;
  requiredRoles: string[];
  bossType: string;
  imageCount: number;
}
 
const BOSS_TYPES = [
  { value: 'Prot', label: 'Prot (Base / Prime)' },
  { value: 'Bt', label: 'Bt' },
  { value: 'Gele', label: 'Gele' },
  { value: 'Dino', label: 'Dino' },
  { value: 'Crom', label: 'Crom' },
  { value: 'Legacy', label: 'Legacy' },
] as const;
const BOSS_TYPE_VALUES = BOSS_TYPES.map((boss) => boss.value);
const CATALOG_PAGE_SIZE = 50;

function ItemEditor({
  item,
  onSaved,
  onRemoved,
}: {
  item: CatalogItem;
  onSaved: (itemId: string, name: string, requiredRoles: string[], bossType: string, imageCount?: number) => void;
  onRemoved: (itemId: string) => Promise<void>;
}) {
  const [name, setName] = useState(item.name);
  const [requiredRoles, setRequiredRoles] = useState(item.requiredRoles);
  const [bossType, setBossType] = useState(
    item.bossType === 'Base' || item.bossType === 'Prime'
      ? 'Prot'
      : BOSS_TYPE_VALUES.includes(item.bossType as typeof BOSS_TYPE_VALUES[number])
        ? item.bossType
        : '',
  );
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [imageVersion, setImageVersion] = useState(0);
  const [expanded, setExpanded] = useState(false);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const form = await buildItemForm(name.trim(), requiredRoles, bossType, files);
      form.set('itemId', item.id);
      const response = await fetch('/api/auction/items', { method: 'PATCH', body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to save item changes.');
      onSaved(item.id, name.trim(), requiredRoles, bossType, files.length || undefined);
      if (files.length) setImageVersion((version) => version + 1);
      setFiles([]);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save item changes.');
    } finally {
      setSaving(false);
    }
  };

  if (!expanded) return <article className="surface item-catalog-card grid min-w-0 max-w-full grid-cols-[3.5rem_minmax(0,1fr)_2.5rem] items-center gap-3 p-3 sm:flex sm:gap-4 sm:p-4"><div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-white/5 bg-slate-950/60 sm:h-16 sm:w-16"><img loading="lazy" decoding="async" width={64} height={64} src={`/api/auction/image?id=${encodeURIComponent(item.id)}&index=0&v=${imageVersion}`} alt={item.name} className="h-full w-full object-contain" /></div><div className="min-w-0"><h4 className="truncate text-sm font-semibold text-slate-200" title={item.name}>{item.name}</h4><div className="mt-2 flex min-w-0 flex-wrap gap-1.5">{item.requiredRoles.map((role) => <RoleBadge key={role} role={role} gameClass />)}<span className="self-center text-[10px] text-slate-500">{item.bossType} / {item.imageCount} image{item.imageCount === 1 ? '' : 's'}</span></div></div><button type="button" className="secondary-button h-10 w-10 shrink-0 !p-0 sm:h-auto sm:w-auto sm:!px-4" onClick={() => setExpanded(true)} aria-label={`Edit ${item.name}`}><Pencil size={13} /><span className="hidden sm:inline">Edit item</span></button></article>;

  return (
    <form onSubmit={save} className="surface grid min-w-0 max-w-full gap-4 p-4 sm:grid-cols-[5rem_minmax(0,1fr)_auto] sm:items-center sm:p-5"><div className="flex min-w-0 items-center justify-between gap-3 border-b border-white/5 pb-3 sm:col-span-3"><p className="truncate text-xs font-semibold text-slate-300">Editing {item.name}</p><button type="button" className="secondary-button" disabled={saving} onClick={() => setExpanded(false)}>Done</button></div>
      <div className="relative h-20 w-20 overflow-hidden rounded-xl bg-slate-900">
        <img
          src={`/api/auction/image?id=${encodeURIComponent(item.id)}&index=0&v=${imageVersion}`}
          loading="lazy" decoding="async" width={80} height={80}
          key={imageVersion}
          alt={item.name}
          className="h-full w-full object-contain"
        />
        {item.imageCount > 1 && (
          <span className="absolute bottom-1 right-1 rounded bg-slate-950/90 px-1.5 py-0.5 text-[10px] text-white">
            {item.imageCount} images
          </span>
        )}
      </div>
      <div className="min-w-0 space-y-2">
        {saving && <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-indigo-200"><LoaderCircle size={13} className="animate-spin" />Saving item changes…</p>}
        <label className="sr-only" htmlFor={`item-name-${item.id}`}>Item name</label>
        <input
          id={`item-name-${item.id}`}
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm font-semibold text-white outline-none focus:border-indigo-400/60"
        />
        <ItemSubrolePicker value={requiredRoles} onChange={setRequiredRoles} disabled={saving} />
        {!resolveItemSubroles(requiredRoles) && <p className="text-xs text-amber-200">Select supported subroles above before saving this item.</p>}
        <label className="sr-only" htmlFor={`item-boss-${item.id}`}>Boss type</label>
        <select
          id={`item-boss-${item.id}`}
          required
          value={bossType}
          onChange={(event) => setBossType(event.target.value)}
          className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 outline-none focus:border-indigo-400/60"
        >
          <option value="">Choose boss type</option>
          {BOSS_TYPES.map((boss) => <option key={boss.value} value={boss.value}>{boss.label}</option>)}
        </select>
        <SquareImageUpload
          files={files}
          onChange={setFiles}
          label={files.length
            ? `${files.length} square-cropped replacement image${files.length === 1 ? '' : 's'} ready · choose again to replace`
            : 'Choose images · frame each item in a square'}
        />
        {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
      </div>
      <div className="flex gap-2 sm:flex-col">
        <button
          type="submit"
          disabled={saving || (!files.length && name.trim() === item.name && requiredRoles.join('|') === item.requiredRoles.join('|') && bossType === item.bossType)}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-indigo-400/30 bg-indigo-400/10 px-4 py-2.5 text-xs font-bold text-indigo-200 transition hover:bg-indigo-400/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            if (!window.confirm(`Remove "${item.name}" from the catalog? Existing auction history will be kept.`)) return;
            setSaving(true);
            setError('');
            try {
              await onRemoved(item.id);
            } catch (removeError) {
              setError(removeError instanceof Error ? removeError.message : 'Unable to remove item.');
            } finally {
              setSaving(false);
            }
          }}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-400/25 bg-rose-400/5 px-3 py-2.5 text-xs font-bold text-rose-200 transition hover:bg-rose-400/10 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`Remove ${item.name} from catalog`}
        >
          <Trash2 className="h-4 w-4" />
          Remove
        </button>
      </div>
    </form>
  );
}

export default function AuctionItemsPanel({ active = true }: { active?: boolean }) {
  const mounted = useRef(true);
  const initialCatalogData = peekData<{ items: CatalogItem[]; roles: string[] }>('/api/auction/items');
  const [items, setItems] = useState<CatalogItem[]>(() => initialCatalogData?.items ?? []);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(() => !peekData('/api/auction/items'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const router = useRouter();

  const loadItems = useCallback(async (maxAgeMs = 0) => {
    const version = clientDataVersion();
    try {
      const result = await getData<{ items: CatalogItem[]; roles: string[] }>('/api/auction/items', { maxAgeMs });
      if (!mounted.current || version !== clientDataVersion()) return;
      setItems(result.items); setError('');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { clearClientData(); router.replace('/login'); }
      throw cause;
    } finally {
      if (mounted.current && version === clientDataVersion()) setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    mounted.current = true;
    const clear = () => { setItems([]); setCreateOpen(false); setLoading(true); };
    window.addEventListener('centuri:clear-data', clear);
    return () => {
      mounted.current = false;
      window.removeEventListener('centuri:clear-data', clear);
    };
  }, [router]);
  useEffect(() => {
    if (!active) return;
    void loadItems(Infinity).catch((cause) => setError(cause instanceof Error ? cause.message : 'The catalog could not be loaded.'));
  }, [active, loadItems]);
  useEffect(() => {
    if (!active) return;
    const reloadForSessionChange = () => {
      void loadItems().catch((cause) => setError(cause instanceof Error ? cause.message : 'The catalog could not be loaded.'));
    };
    window.addEventListener('centuri:session-updated', reloadForSessionChange);
    window.addEventListener('centuri:catalog-changed', reloadForSessionChange);
    return () => {
      window.removeEventListener('centuri:session-updated', reloadForSessionChange);
      window.removeEventListener('centuri:catalog-changed', reloadForSessionChange);
    };
  }, [active, loadItems]);

  const catalogChanged = () => {
    invalidateData('/api/auction/items'); invalidateData('/api/auction');
    window.dispatchEvent(new Event('centuri:catalog-changed'));
  };

  const filteredItems = useMemo(
    () => items.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase())),
    [items, search],
  );
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / CATALOG_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageItems = filteredItems.slice((currentPage - 1) * CATALOG_PAGE_SIZE, currentPage * CATALOG_PAGE_SIZE);

  const updateItem = (
    itemId: string,
    updatedName: string,
    updatedRequiredRoles: string[],
    updatedBossType: string,
    imageCount?: number,
  ) => {
    catalogChanged();
    setItems((current) => current
      .map((item) => item.id === itemId
        ? {
            ...item,
            name: updatedName,
            requiredRoles: updatedRequiredRoles,
            bossType: updatedBossType,
            imageCount: imageCount ?? item.imageCount,
          }
        : item)
      .sort((first, second) => first.name.localeCompare(second.name)));
    setNotice('Saved item updated.');
    setError('');
  };

  const removeItem = async (itemId: string) => {
    const response = await fetch('/api/auction/items', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to remove item.');
    catalogChanged();
    setItems((current) => current.filter((item) => item.id !== itemId));
    setNotice('Item removed. You can reuse its name; existing auction history and images are preserved.');
    setError('');
  };

  return (
    <div className="item-catalog min-w-0 max-w-full space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p className="page-kicker">The clan collection</p><h1 className="page-title">Item catalog</h1><p className="page-description">Manage item images, eligible classes, and the boss they came from.</p></div><button type="button" className="primary-button" disabled={saving} onClick={() => setCreateOpen((current) => !current)} aria-expanded={createOpen} aria-controls="create-catalog-form"><Plus size={15} />{createOpen ? 'Close new item' : 'Add an item'}</button></div>

      {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>}

      {createOpen && <section id="create-catalog-form" className="surface p-5 sm:p-6">
        <AuctionItemCreateForm onClose={() => setCreateOpen(false)} onBusyChange={setSaving} onCreated={(item) => {
          const nextItems = [...items.filter((entry) => entry.id !== item.id), item].sort((a, b) => a.name.localeCompare(b.name));
          setItems(nextItems);
          rememberData('/api/auction/items', { items: nextItems, roles: initialCatalogData?.roles ?? [] });
          setCreateOpen(false);
          setNotice('Item added to the auction catalog.');
          setError('');
          void loadItems().catch((cause) => setError(cause instanceof Error ? cause.message : 'The catalog could not be refreshed yet.'));
        }} />
      </section>}
      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Catalog items</h2>
            <p role="status" className="text-xs text-slate-400">{search.trim() ? `${filteredItems.length} of ${items.length}` : items.length} saved item{items.length === 1 ? '' : 's'}</p>
          </div>
          <label className="relative block sm:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={search}
              onChange={(event) => { setSearch(event.target.value); setPage(1); }}
              aria-label="Search catalog items"
              placeholder="Search items..."
              className="w-full rounded-xl border border-slate-800 bg-slate-950 py-2.5 pl-9 pr-3 text-sm text-white outline-none focus:border-indigo-400/60"
            />
          </label>
        </div>
        {loading ? (
          <div role="status" aria-label="Preparing item catalog" aria-busy="true" className="grid gap-3">
            <span className="sr-only">Preparing item catalog</span>
            {Array.from({ length: 5 }, (_, index) => <article key={index} className="surface flex items-center gap-4 p-4"><div className="skeleton h-16 w-16 shrink-0 rounded-xl" /><div className="min-w-0 flex-1"><div className="skeleton h-4 w-2/5" /><div className="mt-3 flex gap-2"><div className="skeleton h-5 w-20 rounded-full" /><div className="skeleton h-5 w-16 rounded-full" /></div></div><div className="skeleton h-9 w-20 shrink-0 rounded-lg" /></article>)}
          </div>
        ) : filteredItems.length === 0 && !saving ? (
          <EmptyState title={items.length ? 'No items match your search' : 'Your item catalog is ready to grow'} description={items.length ? 'Try a shorter item name or clear your search.' : 'Choose Add an item to upload images and set eligible classes.'} onReset={search.trim() ? () => setSearch('') : undefined} />
        ) : (
          <div className="grid gap-3">
            {saving && <article role="status" aria-label="Adding item to catalog" className="surface flex items-center gap-4 border-indigo-400/20 p-4"><div className="skeleton h-16 w-16 shrink-0 rounded-xl" /><div className="min-w-0 flex-1"><p className="flex items-center gap-2 text-sm font-semibold text-indigo-200"><LoaderCircle size={14} className="animate-spin" />Adding item…</p><p className="mt-2 text-xs text-slate-500">The catalog will update when the upload is confirmed.</p></div></article>}
            {pageItems.map((item) => (
              <ItemEditor key={item.id} item={item} onSaved={updateItem} onRemoved={removeItem} />
            ))}
          </div>
        )}
        {!loading && pageCount > 1 && (
          <nav aria-label="Catalog pages" className="flex items-center justify-between gap-3">
            <button type="button" className="secondary-button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous items</button>
            <p role="status" className="text-xs text-slate-400">Page {currentPage} of {pageCount}</p>
            <button type="button" className="secondary-button" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>Next items</button>
          </nav>
        )}
      </section>
    </div>
  );
}
