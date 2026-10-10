'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImagePlus, LoaderCircle, Package, Save, Search, Trash2 } from 'lucide-react';
import { optimizeImageForUpload } from '@/lib/auctionImageClient';

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
] as const;
const BOSS_TYPE_VALUES = BOSS_TYPES.map((boss) => boss.value);

async function buildItemForm(name: string, requiredRoles: string[], bossType: string, files: File[]) {
  const optimizedFiles = await Promise.all(files.map(optimizeImageForUpload));
  const totalUploadBytes = optimizedFiles.reduce((total, file) => total + file.size, 0);
  if (totalUploadBytes > 2 * 1024 * 1024) {
    throw new Error('The optimized images exceed 2 MB total. Remove an image and try again.');
  }

  const form = new FormData();
  form.set('name', name);
  for (const role of requiredRoles) form.append('requiredRoles', role);
  form.set('bossType', bossType);
  for (const file of optimizedFiles) form.append('images', file);
  return form;
}

function ItemEditor({
  item,
  roles,
  onSaved,
  onRemoved,
}: {
  item: CatalogItem;
  roles: string[];
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

  return (
    <form onSubmit={save} className="grid gap-3 rounded-2xl border border-slate-800 bg-slate-950/50 p-4 sm:grid-cols-[5rem_minmax(0,1fr)_auto] sm:items-center">
      <div className="relative h-20 w-20 overflow-hidden rounded-xl bg-slate-900">
        <img
          src={`/api/auction/image?id=${encodeURIComponent(item.id)}&index=0&v=${imageVersion}`}
          key={imageVersion}
          alt={`${item.name} catalog image`}
          className="h-full w-full object-contain"
        />
        {item.imageCount > 1 && (
          <span className="absolute bottom-1 right-1 rounded bg-slate-950/90 px-1.5 py-0.5 text-[10px] text-white">
            {item.imageCount} images
          </span>
        )}
      </div>
      <div className="min-w-0 space-y-2">
        <label className="sr-only" htmlFor={`item-name-${item.id}`}>Item name</label>
        <input
          id={`item-name-${item.id}`}
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm font-semibold text-white outline-none focus:border-indigo-400/60"
        />
        <fieldset className="space-y-2">
          <legend className="text-xs text-slate-400">Allowed roles (choose up to 2)</legend>
          <div className="grid grid-cols-2 gap-1.5">
            {[...new Set([...requiredRoles, ...roles])].map((role) => (
              <label key={role} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/70 px-2 py-1.5 text-xs capitalize text-slate-300">
                <input type="checkbox" checked={requiredRoles.includes(role)} disabled={!requiredRoles.includes(role) && requiredRoles.length >= 2}
                  onChange={(event) => setRequiredRoles((current) => event.target.checked ? [...current, role] : current.filter((entry) => entry !== role))} />
                {role}{!roles.includes(role) ? ' (not on roster)' : ''}
              </label>
            ))}
          </div>
        </fieldset>
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
        <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400 hover:text-slate-200">
          <ImagePlus className="h-4 w-4 shrink-0 text-indigo-300" />
          <span className="truncate">
            {files.length
              ? `${files.length} replacement image${files.length === 1 ? '' : 's'} selected`
              : 'Choose images to replace the current set'}
          </span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={(event) => {
              setFiles(Array.from(event.target.files ?? []));
              event.currentTarget.value = '';
            }}
            className="sr-only"
          />
        </label>
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

export default function AuctionItemsPanel() {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [requiredRoles, setRequiredRoles] = useState<string[]>([]);
  const [bossType, setBossType] = useState('Prot');
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const router = useRouter();

  const loadItems = async () => {
    const response = await fetch('/api/auction/items', { cache: 'no-store' });
    const result = await response.json();
    if (response.status === 401) {
      router.push('/login');
      return;
    }
    if (!response.ok) throw new Error(result.error || 'Unable to load saved items.');
    setItems(result.items);
    setRoles(result.roles);
  };

  useEffect(() => {
    let mounted = true;
    void fetch('/api/auction/items', { cache: 'no-store' })
      .then(async (response) => {
        const result = await response.json();
        if (response.status === 401) {
          router.push('/login');
          return;
        }
        if (!response.ok) throw new Error(result.error || 'Unable to load saved items.');
        if (mounted) {
          setItems(result.items);
          setRoles(result.roles);
        }
      })
      .catch((loadError: unknown) => {
        if (mounted) setError(loadError instanceof Error ? loadError.message : 'Unable to load saved items.');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [router]);

  const filteredItems = useMemo(
    () => items.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase())),
    [items, search],
  );

  const createItem = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (!files.length) throw new Error('Upload at least one image for the new item.');
      if (!requiredRoles.length) throw new Error('Choose at least one role for this item.');
      const form = await buildItemForm(name.trim(), requiredRoles, bossType, files);
      const response = await fetch('/api/auction/items', { method: 'POST', body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to add saved item.');
      await loadItems();
      setName('');
      setRequiredRoles([]);
      setBossType('Prot');
      setFiles([]);
      setNotice('Item added to the auction catalog.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to add saved item.');
    } finally {
      setSaving(false);
    }
  };

  const updateItem = (
    itemId: string,
    updatedName: string,
    updatedRequiredRoles: string[],
    updatedBossType: string,
    imageCount?: number,
  ) => {
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
    setItems((current) => current.filter((item) => item.id !== itemId));
    setNotice('Item removed from the catalog. Existing auction history is preserved.');
    setError('');
  };

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-indigo-400/20 bg-gradient-to-br from-indigo-950/70 via-slate-900 to-slate-950 p-5 shadow-xl sm:p-7">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-indigo-400/30 bg-indigo-400/10 text-indigo-300">
            <Package className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-300">Auction House</p>
            <h2 className="mt-1 text-xl font-black text-white sm:text-2xl">Saved Items</h2>
            <p className="mt-1 text-sm text-slate-300">Chiefs, Generals, and Guardians can maintain each item’s image, role, and boss type here.</p>
          </div>
        </div>
      </section>

      {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>}

      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
        <div>
          <h3 className="font-bold text-white">Add catalog item</h3>
          <p className="mt-1 text-xs text-slate-400">Save the role and boss type with each item; Base and Prime are grouped as Prot. Images are optimized to WebP.</p>
        </div>
        <form onSubmit={createItem} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <input
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Item name"
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-3 text-sm text-white outline-none focus:border-indigo-400/60"
          />
          <fieldset className="space-y-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2">
            <legend className="px-1 text-xs text-slate-400">Allowed roles (up to 2)</legend>
            <div className="grid grid-cols-2 gap-1">
              {roles.map((role) => (
                <label key={role} className="flex items-center gap-1.5 text-xs capitalize text-slate-300">
                  <input type="checkbox" checked={requiredRoles.includes(role)} disabled={!requiredRoles.includes(role) && requiredRoles.length >= 2}
                    onChange={(event) => setRequiredRoles((current) => event.target.checked ? [...current, role] : current.filter((entry) => entry !== role))} />
                  {role}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="sr-only" htmlFor="new-item-boss">Boss type</label>
          <select
            id="new-item-boss"
            required
            value={bossType}
            onChange={(event) => setBossType(event.target.value)}
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-slate-200 outline-none focus:border-indigo-400/60"
          >
            <option value="">Choose boss type</option>
            {BOSS_TYPES.map((boss) => <option key={boss.value} value={boss.value}>{boss.label}</option>)}
          </select>
          <label className="flex cursor-pointer items-center gap-2 overflow-hidden rounded-xl border border-dashed border-slate-700 bg-slate-950 px-3.5 py-3 text-sm text-slate-300 hover:border-indigo-400/40">
            <ImagePlus className="h-4 w-4 shrink-0 text-indigo-300" />
            <span className="truncate">{files.length ? `${files.length} images selected` : 'Choose up to 8 images'}</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(event) => {
                setFiles(Array.from(event.target.files ?? []));
                event.currentTarget.value = '';
              }}
              className="sr-only"
            />
          </label>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-500 px-4 py-3 text-sm font-bold text-white transition hover:bg-indigo-400 disabled:opacity-50"
          >
            {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
            Add item
          </button>
        </form>
      </section>

      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-lg font-bold text-white">Catalog items</h3>
            <p className="text-xs text-slate-400">{items.length} saved item{items.length === 1 ? '' : 's'}</p>
          </div>
          <label className="relative block sm:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search items..."
              className="w-full rounded-xl border border-slate-800 bg-slate-950 py-2.5 pl-9 pr-3 text-sm text-white outline-none focus:border-indigo-400/60"
            />
          </label>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Loading saved items...
          </div>
        ) : filteredItems.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-800 py-10 text-center text-sm text-slate-500">
            {items.length ? 'No items match your search.' : 'No saved items yet.'}
          </p>
        ) : (
          <div className="grid gap-3">
            {filteredItems.map((item) => (
              <ItemEditor key={item.id} item={item} roles={roles} onSaved={updateItem} onRemoved={removeItem} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
