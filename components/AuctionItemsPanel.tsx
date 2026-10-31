'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Dialog from '@/components/Dialog';
import RoleBadge from '@/components/RoleBadge';
import ItemSubrolePicker from '@/components/ItemSubrolePicker';
import { resolveItemSubroles } from '@/lib/auctionRules';
import { ApiError, clearClientData, clientDataVersion, getData, invalidateData, peekData, rememberData } from '@/lib/client/api';
import { ImagePlus, LoaderCircle, Package, Save, Search, Trash2, Pencil, ChevronDown, ChevronUp, Plus } from 'lucide-react';
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
  { value: 'Legacy', label: 'Legacy' },
] as const;
const BOSS_TYPE_VALUES = BOSS_TYPES.map((boss) => boss.value);

function SquareImageCropStep({
  file,
  step,
  total,
  onComplete,
  onCancel,
}: {
  file: File;
  step: number;
  total: number;
  onComplete: (croppedFile: File) => void;
  onCancel: () => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragOrigin = useRef<{ pointerX: number; pointerY: number; cropX: number; cropY: number; scale: number } | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0, zoom: 1 });
  const [frameSize, setFrameSize] = useState(320);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
      setCrop({
        x: Math.max(0, (image.naturalWidth - Math.min(image.naturalWidth, image.naturalHeight)) / 2),
        y: Math.max(0, (image.naturalHeight - Math.min(image.naturalWidth, image.naturalHeight)) / 2),
        zoom: 1,
      });
      setSourceUrl(url);
    };
    image.onerror = () => setError('This image could not be opened. Choose another image.');
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !('ResizeObserver' in window)) return;
    const observer = new ResizeObserver(([entry]) => setFrameSize(entry.contentRect.width));
    observer.observe(frame);
    return () => observer.disconnect();
  }, [sourceUrl]);

  const shortSide = dimensions ? Math.min(dimensions.width, dimensions.height) : 1;
  const cropSide = shortSide / crop.zoom;
  const scale = frameSize / cropSide;
  const clamp = (value: number, maximum: number) => Math.min(Math.max(value, 0), maximum);

  const setZoom = (zoom: number) => {
    if (!dimensions) return;
    const boundedZoom = Math.min(3, Math.max(1, zoom));
    const nextSide = shortSide / boundedZoom;
    const centerX = crop.x + cropSide / 2;
    const centerY = crop.y + cropSide / 2;
    setCrop({
      x: clamp(centerX - nextSide / 2, dimensions.width - nextSide),
      y: clamp(centerY - nextSide / 2, dimensions.height - nextSide),
      zoom: boundedZoom,
    });
  };

  const finishCrop = async () => {
    if (!dimensions || !imageRef.current || processing) return;
    setProcessing(true);
    setError('');
    try {
      await imageRef.current.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 768;
      canvas.height = 768;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Your browser could not prepare this crop.');
      context.drawImage(imageRef.current, crop.x, crop.y, cropSide, cropSide, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.92));
      if (!blob) throw new Error('Your browser could not create this crop.');
      const baseName = file.name.replace(/\.[^.]+$/, '') || 'auction-item';
      onComplete(new File([blob], `${baseName}-square.webp`, { type: 'image/webp' }));
    } catch (cropError) {
      setError(cropError instanceof Error ? cropError.message : 'Unable to crop this image.');
      setProcessing(false);
    }
  };

  return (
    <Dialog labelledBy="square-crop-title" busy={processing} onClose={onCancel} className="!max-w-lg">
      <div className="w-full max-w-lg rounded-3xl border border-indigo-300/20 bg-slate-950 p-4 shadow-2xl shadow-black/50 sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-indigo-300">Image framing · {step} of {total}</p>
            <h3 id="square-crop-title" className="mt-1 text-lg font-black text-white">Choose the item crop</h3>
            <p className="mt-1 text-xs text-slate-400">Drag the image to frame the item. Use zoom to adjust the crop size.</p>
          </div>
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800">Cancel</button>
        </div>

        <div
          ref={frameRef}
          role="img"
          aria-label="Image crop. Use arrow keys to move the image; adjust zoom with the slider below."
          tabIndex={0}
          onKeyDown={(event) => {
            if (!dimensions || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const step = cropSide * (event.shiftKey ? 0.1 : 0.02);
            setCrop((current) => ({...current,x:clamp(current.x+(event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),dimensions.width-cropSide),y:clamp(current.y+(event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),dimensions.height-cropSide)}));
          }}
          className="relative mx-auto aspect-square w-[min(80vw,320px)] touch-none cursor-grab overflow-hidden rounded-2xl border-2 border-indigo-300/70 bg-slate-900 shadow-[0_0_35px_rgba(99,102,241,0.15)] active:cursor-grabbing"
          onPointerDown={(event) => {
            if (!dimensions) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            dragOrigin.current = { pointerX: event.clientX, pointerY: event.clientY, cropX: crop.x, cropY: crop.y, scale };
          }}
          onPointerMove={(event) => {
            const origin = dragOrigin.current;
            if (!origin || !dimensions) return;
            setCrop((current) => ({
              ...current,
              x: clamp(origin.cropX - (event.clientX - origin.pointerX) / origin.scale, dimensions.width - cropSide),
              y: clamp(origin.cropY - (event.clientY - origin.pointerY) / origin.scale, dimensions.height - cropSide),
            }));
          }}
          onPointerUp={() => { dragOrigin.current = null; }}
          onPointerCancel={() => { dragOrigin.current = null; }}
        >
          {sourceUrl && dimensions ? (
            <img
              ref={imageRef}
              src={sourceUrl}
              alt="Move and zoom to select the square item crop"
              draggable={false}
              className="pointer-events-none absolute max-w-none select-none"
              style={{ width: dimensions.width * scale, height: dimensions.height * scale, left: -crop.x * scale, top: -crop.y * scale }}
            />
          ) : <LoaderCircle className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 animate-spin text-indigo-300" />}
          <div className="pointer-events-none absolute inset-0 border border-white/40" />
          <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/65 px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-white">Square preview</span>
        </div>

        <label className="mt-5 block space-y-2 text-xs font-semibold text-slate-300">
          <span className="flex items-center justify-between"><span>Zoom</span><span className="font-mono text-indigo-200">{crop.zoom.toFixed(1)}×</span></span>
          <input type="range" min="1" max="3" step="0.05" value={crop.zoom} onChange={(event) => setZoom(Number(event.target.value))} className="w-full accent-indigo-400" />
        </label>
        {error && <p role="alert" className="mt-3 text-xs text-rose-300">{error}</p>}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onCancel} className="flex-1 rounded-xl border border-slate-700 px-4 py-3 text-sm font-bold text-slate-300 hover:bg-slate-900">Cancel images</button>
          <button type="button" disabled={!dimensions || processing} onClick={() => void finishCrop()} className="flex-1 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-3 text-sm font-black text-white shadow-lg shadow-indigo-950/40 hover:from-indigo-400 hover:to-violet-400 disabled:opacity-50">
            {processing ? <span className="inline-flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin" /> Preparing…</span> : step < total ? 'Use crop · Next image' : 'Use square crop'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function SquareImageUpload({
  files,
  onChange,
  label,
  multiple = true,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  label: string;
  multiple?: boolean;
}) {
  const [queue, setQueue] = useState<File[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [croppedFiles, setCroppedFiles] = useState<File[]>([]);
  const [cropperOpen, setCropperOpen] = useState(false);
  const [selectionError, setSelectionError] = useState('');

  const beginCrop = (selectedFiles: File[]) => {
    setSelectionError('');
    if (multiple && selectedFiles.length > 8) {
      setSelectionError('Choose no more than 8 images at a time.');
      return;
    }
    const selection = multiple ? selectedFiles : selectedFiles.slice(0, 1);
    if (!selection.length) return;
    setQueue(selection);
    setQueueIndex(0);
    setCroppedFiles([]);
    setCropperOpen(true);
  };

  const completeCurrentCrop = (file: File) => {
    const nextFiles = [...croppedFiles, file];
    if (queueIndex + 1 < queue.length) {
      setCroppedFiles(nextFiles);
      setQueueIndex((index) => index + 1);
      return;
    }
    onChange(nextFiles);
    setCropperOpen(false);
    setQueue([]);
  };

  return (
    <>
      <label className="flex cursor-pointer items-center gap-2 overflow-hidden rounded-xl border border-dashed border-slate-700 bg-slate-950 px-3.5 py-3 text-sm text-slate-300 transition hover:border-indigo-400/50 hover:bg-indigo-400/[0.04]">
        <ImagePlus className="h-4 w-4 shrink-0 text-indigo-300" />
        <span className="truncate">{label}</span>
        <input type="file" accept="image/png,image/jpeg,image/webp" multiple={multiple} onChange={(event) => { beginCrop(Array.from(event.target.files ?? [])); event.currentTarget.value = ''; }} className="sr-only" />
      </label>
      {selectionError && <p role="alert" className="text-[10px] text-rose-300">{selectionError}</p>}
      {cropperOpen && queue[queueIndex] && <SquareImageCropStep key={`${queueIndex}-${queue[queueIndex].name}-${queue[queueIndex].lastModified}`} file={queue[queueIndex]} step={queueIndex + 1} total={queue.length} onComplete={completeCurrentCrop} onCancel={() => { setCropperOpen(false); setQueue([]); setCroppedFiles([]); }} />}
      {files.length > 0 && <p className="text-[10px] text-emerald-300">{files.length} square-cropped image{files.length === 1 ? '' : 's'} ready</p>}
    </>
  );
}

async function buildItemForm(name: string, requiredRoles: string[], bossType: string, files: File[]) {
  const subroles = resolveItemSubroles(requiredRoles);
  if (!subroles) throw new Error('Choose one or two subroles with icons, or Everyone on its own.');
  const optimizedFiles = await Promise.all(files.map(optimizeImageForUpload));
  const totalUploadBytes = optimizedFiles.reduce((total, file) => total + file.size, 0);
  if (totalUploadBytes > 2 * 1024 * 1024) {
    throw new Error('The optimized images exceed 2 MB total. Remove an image and try again.');
  }

  const form = new FormData();
  form.set('name', name);
  for (const role of subroles) form.append('requiredRoles', role);
  form.set('bossType', bossType);
  for (const file of optimizedFiles) form.append('images', file);
  return form;
}

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
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [requiredRoles, setRequiredRoles] = useState<string[]>([]);
  const [bossType, setBossType] = useState('Prot');
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(() => !peekData('/api/auction/items'));
  const [saving, setSaving] = useState(false);
  const [pendingMessage, setPendingMessage] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const initialLoadStarted = useRef(false);
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
    const clear = () => { initialLoadStarted.current = false; setItems([]); setCreateOpen(false); setName(''); setFiles([]); setLoading(true); };
    window.addEventListener('centuri:clear-data', clear);
    return () => {
      mounted.current = false;
      window.removeEventListener('centuri:clear-data', clear);
    };
  }, [router]);
  useEffect(() => {
    if (!active || initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void loadItems(15_000).catch((cause) => setError(cause instanceof Error ? cause.message : 'The catalog could not be loaded.'));
  }, [active, loadItems]);
  useEffect(() => {
    if (!active) return;
    const reloadForSessionChange = () => {
      initialLoadStarted.current = true;
      void loadItems().catch((cause) => setError(cause instanceof Error ? cause.message : 'The catalog could not be loaded.'));
    };
    window.addEventListener('centuri:session-updated', reloadForSessionChange);
    return () => window.removeEventListener('centuri:session-updated', reloadForSessionChange);
  }, [active, loadItems]);

  const catalogChanged = () => {
    invalidateData('/api/auction/items'); invalidateData('/api/auction');
    window.dispatchEvent(new Event('centuri:catalog-changed'));
  };

  const filteredItems = useMemo(
    () => items.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase())),
    [items, search],
  );

  const createItem = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    setPendingMessage('Preparing images and adding the item…');
    try {
      if (!files.length) throw new Error('Upload at least one image for the new item.');
      if (!requiredRoles.length) throw new Error('Choose at least one role for this item.');
      const form = await buildItemForm(name.trim(), requiredRoles, bossType, files);
      const response = await fetch('/api/auction/items', { method: 'POST', body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to add saved item.');
      const createdItem: CatalogItem = { id: result.id, name: name.trim(), requiredRoles, bossType, imageCount: files.length };
      const nextItems = [...items.filter((item) => item.id !== createdItem.id), createdItem].sort((first, second) => first.name.localeCompare(second.name));
      const cachedCatalog = peekData<{ items: CatalogItem[]; roles: string[] }>('/api/auction/items');
      catalogChanged();
      setItems(nextItems);
      rememberData('/api/auction/items', { items: nextItems, roles: cachedCatalog?.roles ?? [] });
      void loadItems().catch((cause) => setError(cause instanceof Error ? cause.message : 'The item was added, but the catalog could not be refreshed yet.'));
      setName('');
      setRequiredRoles([]);
      setBossType('Prot');
      setFiles([]);
      setCreateOpen(false);
      setNotice('Item added to the auction catalog.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to add saved item.');
    } finally {
      setSaving(false);
      setPendingMessage('');
    }
  };

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
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p className="page-kicker">The clan collection</p><h1 className="page-title">Great loot starts here.</h1><p className="page-description">Manage item images, eligible classes, and the boss they came from.</p></div><button type="button" className="primary-button" onClick={() => setCreateOpen((current) => !current)} aria-expanded={createOpen} aria-controls="create-catalog-form"><Plus size={15} />{createOpen ? 'Close new item' : 'Add an item'}</button></div>

      {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>}

      {createOpen && <section id="create-catalog-form" className="surface space-y-4 p-5 sm:p-6">
        <div>
          <h3 className="font-bold text-white">Add catalog item</h3>
          <p className="mt-1 text-xs text-slate-400">Choose a boss or Legacy, then select eligible subroles. Everyone opens bidding to every linked toon.</p>
        </div>
        <form onSubmit={createItem} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-2">
          <input
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="New catalog item name"
            placeholder="Item name"
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-3 text-sm text-white outline-none focus:border-indigo-400/60"
          />
          <ItemSubrolePicker value={requiredRoles} onChange={setRequiredRoles} disabled={saving} />
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
          <SquareImageUpload
            files={files}
            onChange={setFiles}
            label={files.length ? `${files.length} square-cropped image${files.length === 1 ? '' : 's'} ready · choose again to replace` : 'Choose up to 8 images · frame each item in a square'}
          />
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-500 px-4 py-3 text-sm font-bold text-white transition hover:bg-indigo-400 disabled:opacity-50"
          >
            {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
            {saving ? 'Adding item…' : 'Add item'}
          </button>
        </form>
      </section>}

      {pendingMessage && <p role="status" aria-live="polite" className="flex items-center gap-2 rounded-xl border border-indigo-400/20 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-200"><LoaderCircle size={15} className="animate-spin" />{pendingMessage}</p>}

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
          <p className="rounded-2xl border border-dashed border-slate-800 py-10 text-center text-sm text-slate-500">
            {items.length ? 'No items match your search.' : 'No saved items yet.'}
          </p>
        ) : (
          <div className="grid gap-3">
            {saving && <article role="status" aria-label="Adding item to catalog" className="surface flex items-center gap-4 border-indigo-400/20 p-4"><div className="skeleton h-16 w-16 shrink-0 rounded-xl" /><div className="min-w-0 flex-1"><p className="flex items-center gap-2 text-sm font-semibold text-indigo-200"><LoaderCircle size={14} className="animate-spin" />Adding item…</p><p className="mt-2 text-xs text-slate-500">The catalog will update when the upload is confirmed.</p></div></article>}
            {filteredItems.map((item) => (
              <ItemEditor key={item.id} item={item} onSaved={updateItem} onRemoved={removeItem} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
