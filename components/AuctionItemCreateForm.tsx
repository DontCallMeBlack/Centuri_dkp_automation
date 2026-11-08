'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, ImagePlus, LoaderCircle, PackagePlus, X } from 'lucide-react';
import BossIcon from '@/components/BossIcon';
import ItemSubrolePicker from '@/components/ItemSubrolePicker';
import { SquareImageUpload, buildItemForm } from '@/components/AuctionItemUpload';
import { clientDataVersion, invalidateData } from '@/lib/client/api';
import { resolveItemSubroles } from '@/lib/auctionRules';

export interface AuctionCatalogItem {
  id: string;
  name: string;
  requiredRoles: string[];
  bossType: string;
  imageCount: number;
  imageVersion?: string;
}

const BOSSES = ['Prot', 'Bt', 'Gele', 'Dino', 'Crom', 'Legacy'];

export default function AuctionItemCreateForm({ initialName = '', forPosting = false, onCreated, onClose, onBusyChange }: {
  initialName?: string;
  forPosting?: boolean;
  onCreated: (item: AuctionCatalogItem) => void;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const mounted = useRef(true);
  const submitting = useRef(false);
  const [name, setName] = useState(initialName.slice(0, 120));
  const [requiredRoles, setRequiredRoles] = useState<string[]>([]);
  const [bossType, setBossType] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    onBusyChange?.(true);
    setError('');
    const version = clientDataVersion();
    try {
      if (!files.length) throw new Error('Add at least one item image.');
      const form = await buildItemForm(name.trim(), requiredRoles, bossType, files);
      if (version !== clientDataVersion() || !mounted.current) return;
      const response = await fetch('/api/auction/items', { method: 'POST', body: form });
      const result = await response.json();
      if (version !== clientDataVersion() || !mounted.current) return;
      if (!response.ok) throw new Error(result.error || 'Unable to add this item.');
      if (typeof result.id !== 'string') throw new Error('The saved item could not be confirmed. Refresh the catalog before retrying.');
      invalidateData('/api/auction/items');
      invalidateData('/api/auction');
      onCreated({ id: result.id, name: name.trim(), requiredRoles, bossType, imageCount: files.length, imageVersion: result.imageVersion });
      window.dispatchEvent(new Event('centuri:catalog-changed'));
    } catch (cause) {
      if (mounted.current && version === clientDataVersion()) setError(cause instanceof Error ? cause.message : 'Unable to add this item.');
    } finally {
      submitting.current = false;
      if (mounted.current) setSaving(false);
      onBusyChange?.(false);
    }
  };

  return <section className="auction-item-create" aria-labelledby={`${id}-title`} aria-busy={saving}>
    <header className="flex items-start justify-between gap-4 border-b border-white/10 pb-5">
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-amber-200/20 bg-amber-200/10 text-amber-200"><PackagePlus size={21} /></span>
        <div><p className="text-[10px] font-bold uppercase tracking-[.2em] text-amber-200/70">Grow the collection</p><h2 id={`${id}-title`} className="mt-1 text-xl font-semibold text-white">Add a new item</h2><p className="mt-1 text-xs leading-5 text-slate-400">{forPosting ? 'Save it to the catalog, then it’s ready for your auction.' : 'A great image makes your next drop easy to find.'}</p></div>
      </div>
      <button type="button" disabled={saving} onClick={onClose} aria-label="Close new item panel" className="auction-icon-button"><X size={18} /></button>
    </header>
    <form onSubmit={create} className="mt-5 space-y-6">
      <fieldset disabled={saving} className="min-w-0 space-y-6">
        <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <div className="min-w-0 space-y-3">
            <p className="auction-field-label"><ImagePlus size={14} /> Item images</p>
            <div className="auction-upload-preview">
              {previews.length ? <img src={previews[0]} alt="New item preview" className="h-full w-full object-contain p-3" /> : <div className="flex flex-col items-center gap-3 px-4 text-center"><span className="grid h-16 w-16 place-items-center rounded-2xl border border-amber-100/15 bg-amber-100/5 text-amber-200"><ImagePlus size={28} strokeWidth={1.3} /></span><span className="text-sm font-medium text-slate-200">Show off the loot</span><span className="max-w-48 text-xs leading-5 text-slate-500">Upload an item screenshot and frame it with the square crop tool.</span></div>}
              {previews.length > 0 && <span className="absolute bottom-3 right-3 rounded-full border border-white/10 bg-slate-950/90 px-2.5 py-1 text-[10px] text-slate-200">{previews.length} / 8 images</span>}
            </div>
            {previews.length > 1 && <div className="flex flex-wrap gap-2">{previews.map((url, index) => <img key={url} src={url} alt={`Item image ${index + 1}`} className="h-11 w-11 rounded-lg border border-white/10 object-contain" />)}</div>}
            <SquareImageUpload files={files} onChange={setFiles} label={files.length ? 'Replace images' : 'Choose up to 8 images'} />
          </div>
          <div className="min-w-0 space-y-5">
            <div><label className="auction-field-label" htmlFor={`${id}-name`}>Item name</label><input id={`${id}-name`} autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="What’s the item called?" className="auction-text-input mt-2" /></div>
            <fieldset><legend className="auction-field-label mb-2">Dropped by</legend><div className="grid grid-cols-3 gap-2">{BOSSES.map((boss) => <label key={boss} className={`auction-boss-choice ${bossType === boss ? 'is-selected' : ''}`}><input type="radio" name={`${id}-boss`} value={boss} checked={bossType === boss} onChange={() => setBossType(boss)} required className="peer sr-only" /><BossIcon bossName={boss === 'Prot' ? 'Prime' : boss} className="h-9 w-9" /><span>{boss}</span>{bossType === boss && <Check size={11} className="absolute right-1.5 top-1.5 text-amber-200" />}</label>)}</div><p className="mt-2 text-[10px] text-slate-500">Prot includes Base and Prime.</p></fieldset>
          </div>
        </div>
        <ItemSubrolePicker value={requiredRoles} onChange={setRequiredRoles} disabled={saving} />
      </fieldset>
      {error && <p role="alert" className="rounded-xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">{error}</p>}
      <div className="flex flex-col-reverse gap-3 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <button type="button" disabled={saving} onClick={onClose} className="secondary-button">Cancel</button>
        <button type="submit" disabled={saving || !name.trim() || !bossType || !files.length || !resolveItemSubroles(requiredRoles)} className="primary-button disabled:cursor-not-allowed disabled:opacity-40">{saving ? <LoaderCircle size={16} className="animate-spin" /> : <ArrowRight size={16} />}{saving ? 'Saving item…' : forPosting ? 'Save & select item' : 'Add to catalog'}</button>
      </div>
      {saving && <p role="status" aria-live="polite" className="text-xs text-amber-100">Preparing your images and saving the item…</p>}
    </form>
  </section>;
}
