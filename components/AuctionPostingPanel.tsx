'use client';

import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Clock3, Gavel, LoaderCircle, PackageSearch, Plus, Search, ShieldCheck, Sparkles } from 'lucide-react';
import AuctionItemImage from '@/components/AuctionItemImage';
import AuctionItemCreateForm, { type AuctionCatalogItem } from '@/components/AuctionItemCreateForm';
import RoleBadge from '@/components/RoleBadge';
import Dialog from '@/components/Dialog';
import { resolveItemSubroles } from '@/lib/auctionRules';

export default function AuctionPostingPanel({ items, selectedItemId, onSelect, onItemCreated, onSubmit, onClose, saving }: {
  items: AuctionCatalogItem[];
  selectedItemId: string;
  onSelect: (id: string) => void;
  onItemCreated: (item: AuctionCatalogItem) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onClose: () => void;
  saving: boolean;
}) {
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(18);
  const [addingItem, setAddingItem] = useState(false);
  const [addingBusy, setAddingBusy] = useState(false);
  const [addedName, setAddedName] = useState('');
  const previewRef = useRef<HTMLElement>(null);
  const filtered = items.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = items.find((item) => item.id === selectedItemId);
  const valid = Boolean(selected && resolveItemSubroles(selected.requiredRoles));

  return <section id="auction-post-form" className="auction-posting-space space-y-5" aria-labelledby="auction-post-title">
    <div className="auction-post-intro">
      <div><p className="page-kicker">From raid to reward</p><h2 id="auction-post-title" className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">Give great loot its next home.</h2><p className="mt-2 max-w-xl text-sm leading-6 text-slate-400">Pick an item, check the preview, and let the bidding begin.</p></div>
      <div className="auction-post-steps" aria-label="Posting progress"><span className="is-current"><span>{selected ? <Check size={12} /> : '1'}</span>Choose loot</span><i /><span className={selected ? 'is-current' : ''}><span>2</span>Review & post</span></div>
    </div>
    {addedName && <p role="status" className="flex items-center gap-2 rounded-xl border border-emerald-300/20 bg-emerald-300/5 px-4 py-3 text-sm text-emerald-200"><Check size={16} />{addedName} is saved and selected. Review it before posting.</p>}
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="auction-picker min-w-0" aria-label="Choose a catalog item">
        <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-white">Find your loot</h3><p className="mt-1 text-xs text-slate-500">Your clan’s collection, ready to auction.</p></div><span className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-slate-400">{items.length} items</span></div>
        <label className="relative mt-5 block"><Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" /><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setLimit(18); }} aria-label="Search items to auction" placeholder="Search by item name…" autoComplete="off" className="auction-text-input !pl-11" /></label>
        <div className="my-4 flex flex-wrap items-center justify-between gap-2"><p role="status" className="text-[11px] text-slate-500">{search.trim() ? `${filtered.length} matching item${filtered.length === 1 ? '' : 's'}` : 'Select an item to preview'}</p><button type="button" disabled={saving} onClick={() => setAddingItem(true)} className="auction-add-item-link"><Plus size={13} />Add new item</button></div>
        {filtered.length ? <div className="auction-picker-grid">{filtered.slice(0, limit).map((item) => <button key={item.id} type="button" disabled={saving} aria-pressed={selectedItemId === item.id} onClick={() => { onSelect(item.id); setAddedName(''); }} className={`auction-picker-card ${selectedItemId === item.id ? 'is-selected' : ''}`}>
          <div className="relative"><AuctionItemImage itemId={item.id} imageCount={item.imageCount} alt={item.name} className="auction-picker-image aspect-square w-full" showNavigation={false} /><span className="absolute bottom-2 left-2 rounded-md border border-white/10 bg-slate-950/85 px-2 py-0.5 text-[9px] text-slate-300">{item.bossType}</span><span className={`auction-selection-mark ${selectedItemId === item.id ? 'is-selected' : ''}`}>{selectedItemId === item.id && <Check size={13} strokeWidth={3} />}</span></div>
          <div className="p-3 text-left"><p className="break-words text-xs font-semibold leading-5 text-slate-100">{item.name}</p><p className="mt-1.5 break-words text-[10px] leading-4 text-slate-500">{item.requiredRoles.join(' / ') || 'Roles needed'}</p></div>
        </button>)}</div> : <div className="auction-search-empty"><span className="grid h-16 w-16 place-items-center rounded-2xl border border-amber-200/15 bg-amber-200/5 text-amber-200"><PackageSearch size={29} strokeWidth={1.3} /></span><h4 className="mt-4 font-semibold text-white">{search.trim() ? 'A new discovery?' : 'Your collection starts here'}</h4><p className="mt-2 max-w-xs break-words text-sm leading-6 text-slate-400">{search.trim() ? `We couldn’t find “${search.trim()}”. Add it to the collection and keep going.` : 'Add your first item with an image, its boss, and eligible subroles.'}</p><button type="button" disabled={saving} onClick={() => setAddingItem(true)} className="primary-button mt-5"><Plus size={15} />Add this item</button></div>}
        {filtered.length > limit && <button type="button" onClick={() => setLimit((current) => current + 18)} className="secondary-button mt-4 w-full">Show more items ({filtered.length - limit})</button>}
        {selected && <button type="button" onClick={() => previewRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })} className="primary-button mt-4 w-full lg:!hidden">Review selected item<ArrowRight size={15} /></button>}
      </section>
      <aside ref={previewRef} className="auction-post-preview scroll-mt-5 lg:sticky lg:top-5" aria-label="Auction preview">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4"><span className="flex items-center gap-2 text-xs font-semibold text-amber-100"><Sparkles size={14} />Auction preview</span><span className="text-[9px] font-bold uppercase tracking-[.18em] text-slate-500">{selected ? 'Ready to review' : 'Awaiting loot'}</span></div>
        <div className="p-5">
          <div className="auction-preview-visual">{selected ? <AuctionItemImage key={selected.id} itemId={selected.id} imageCount={selected.imageCount} alt={selected.name} className="aspect-square w-full" showNameOnError /> : <div className="flex aspect-square flex-col items-center justify-center gap-4"><span className="auction-preview-emblem"><Gavel size={39} strokeWidth={1.15} /></span><span className="text-xs text-slate-500">Your next auction goes here</span></div>}</div>
          <p className="mt-5 text-[9px] font-bold uppercase tracking-[.2em] text-amber-200/70">{selected?.bossType ?? 'The next great drop'}</p><h3 className="mt-2 break-words text-xl font-semibold leading-7 text-white">{selected?.name ?? 'Choose something worth bidding for.'}</h3>
          <div className="mt-3 flex flex-wrap gap-2">{selected?.requiredRoles.map((role) => <RoleBadge key={role} role={role} gameClass />)}</div>
          <div className="mt-5 space-y-3 border-y border-white/10 py-4"><p className="flex items-center justify-between text-xs text-slate-400"><span className="flex items-center gap-2"><Clock3 size={14} />Duration</span><span className="font-semibold text-slate-200">24 hours</span></p><p className="flex items-center gap-2 text-xs text-slate-400"><ShieldCheck size={14} className="shrink-0" />Final 5-minute bids reset the clock to 5 minutes.</p></div>
          {selected && !valid && <p role="alert" className="mt-4 text-xs leading-5 text-amber-200">Set supported subroles for this item in the item catalog before posting.</p>}
          <form onSubmit={onSubmit} className="mt-5"><button type="submit" disabled={saving || !valid} className="primary-button w-full disabled:cursor-not-allowed disabled:opacity-40">{saving ? <LoaderCircle size={16} className="animate-spin" /> : <Gavel size={16} />}{saving ? 'Posting auction…' : 'Post 24-hour auction'}<ArrowRight size={15} /></button></form>
          <button type="button" disabled={saving} onClick={onClose} className="mt-4 flex w-full items-center justify-center gap-2 py-1 text-xs text-slate-500 transition hover:text-slate-200"><ArrowLeft size={12} />Cancel</button>
        </div>
      </aside>
    </div>
    {addingItem && <Dialog labelledBy="add-auction-item-title" busy={addingBusy} onClose={() => setAddingItem(false)} className="auction-create-dialog"><span id="add-auction-item-title" className="sr-only">Add a new item for auction</span><AuctionItemCreateForm initialName={search.trim()} forPosting onBusyChange={setAddingBusy} onClose={() => setAddingItem(false)} onCreated={(item) => { onItemCreated(item); setSearch(''); setAddedName(item.name); setAddingItem(false); }} /></Dialog>}
  </section>;
}
