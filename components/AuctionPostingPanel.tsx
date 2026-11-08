'use client';

import { useState } from 'react';
import { Check, Gavel, LoaderCircle, PackageSearch, Plus, Search } from 'lucide-react';
import AuctionItemImage from '@/components/AuctionItemImage';
import AuctionItemCreateForm, { type AuctionCatalogItem } from '@/components/AuctionItemCreateForm';
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
  const filtered = items.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = items.find((item) => item.id === selectedItemId);
  const valid = Boolean(selected && resolveItemSubroles(selected.requiredRoles));

  return <section id="auction-post-form" className="auction-posting-space space-y-5" aria-label="Select an item to post">
    {addedName && <p role="status" className="flex items-center gap-2 rounded-xl border border-emerald-300/20 bg-emerald-300/5 px-4 py-3 text-sm text-emerald-200"><Check size={16} />{addedName} is saved and ready to post.</p>}

      <section className="auction-picker min-w-0" aria-label="Choose a catalog item">
        <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-white">Find your loot</h3><p className="mt-1 text-xs text-slate-500">Your clan’s collection, ready to auction.</p></div><span className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-slate-400">{items.length} items</span></div>
        <label className="relative mt-5 block"><Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" /><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setLimit(18); }} aria-label="Search items to auction" placeholder="Search by item name…" autoComplete="off" className="auction-text-input !pl-11" /></label>
        <div className="my-4 flex flex-wrap items-center justify-between gap-2"><p role="status" className="text-[11px] text-slate-500">{search.trim() ? `${filtered.length} matching item${filtered.length === 1 ? '' : 's'}` : 'Select an item to post'}</p><button type="button" disabled={saving} onClick={() => setAddingItem(true)} className="auction-add-item-link"><Plus size={13} />Add new item</button></div>
        {filtered.length ? <div className="auction-picker-grid">{filtered.slice(0, limit).map((item) => <button key={item.id} type="button" disabled={saving} aria-pressed={selectedItemId === item.id} onClick={() => { onSelect(item.id); setAddedName(''); }} className={`auction-picker-card ${selectedItemId === item.id ? 'is-selected' : ''}`}>
          <div className="relative"><AuctionItemImage itemId={item.id} imageCount={item.imageCount} imageVersion={item.imageVersion} alt={item.name} className="auction-picker-image aspect-square w-full" showNavigation={false} /><span className="absolute bottom-2 left-2 rounded-md border border-white/10 bg-slate-950/85 px-2 py-0.5 text-[9px] text-slate-300">{item.bossType}</span></div>
          <div className="p-3 text-left"><p className="flex items-start gap-1.5 text-xs font-semibold leading-5 text-slate-100">{selectedItemId === item.id && <Check aria-label="Selected" size={14} strokeWidth={2.5} className="mt-0.5 shrink-0 text-emerald-300" />}<span className="break-words">{item.name}</span></p><p className="auction-picker-roles mt-1.5 break-words text-[10px] leading-4 text-slate-500">{item.requiredRoles.join(' / ') || 'Roles needed'}</p></div>
        </button>)}</div> : <div className="auction-search-empty"><span className="grid h-16 w-16 place-items-center rounded-2xl border border-amber-200/15 bg-amber-200/5 text-amber-200"><PackageSearch size={29} strokeWidth={1.3} /></span><h4 className="mt-4 font-semibold text-white">{search.trim() ? 'A new discovery?' : 'Your collection starts here'}</h4><p className="mt-2 max-w-xs break-words text-sm leading-6 text-slate-400">{search.trim() ? `We couldn’t find “${search.trim()}”. Add it to the collection and keep going.` : 'Add your first item with an image, its boss, and eligible subroles.'}</p><button type="button" disabled={saving} onClick={() => setAddingItem(true)} className="primary-button mt-5"><Plus size={15} />Add this item</button></div>}
        {filtered.length > limit && <button type="button" onClick={() => setLimit((current) => current + 18)} className="secondary-button mt-4 w-full">Show more items ({filtered.length - limit})</button>}
      </section>
      {selected && !valid && <p role="alert" className="text-xs leading-5 text-amber-200">Set supported subroles for this item in the item catalog before posting.</p>}
      <form onSubmit={onSubmit} className="auction-post-actions">
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-200">{selected?.name ?? 'Choose an item to post'}</p><p className="mt-1 text-xs text-slate-500">24-hour auction</p></div>
        <div className="flex gap-3">
          <button type="button" disabled={saving} onClick={onClose} className="secondary-button">Cancel</button>
          <button type="submit" disabled={saving || !valid} className="primary-button disabled:cursor-not-allowed disabled:opacity-40">{saving ? <LoaderCircle size={16} className="animate-spin" /> : <Gavel size={16} />}{saving ? 'Posting auction…' : 'Post 24-hour auction'}</button>
        </div>
      </form>
    {addingItem && <Dialog labelledBy="add-auction-item-title" busy={addingBusy} onClose={() => setAddingItem(false)} className="auction-create-dialog"><span id="add-auction-item-title" className="sr-only">Add a new item for auction</span><AuctionItemCreateForm initialName={search.trim()} forPosting onBusyChange={setAddingBusy} onClose={() => setAddingItem(false)} onCreated={(item) => { onItemCreated(item); setSearch(''); setAddedName(item.name); setAddingItem(false); }} /></Dialog>}
  </section>;
}
