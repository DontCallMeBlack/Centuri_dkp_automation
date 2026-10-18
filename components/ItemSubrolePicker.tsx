'use client';

import RoleBadge from '@/components/RoleBadge';
import { ITEM_SUBROLES, normalizeAuctionRole } from '@/lib/auctionRules';
import { Check } from 'lucide-react';

export default function ItemSubrolePicker({ value, onChange, disabled = false }: { value: string[]; onChange: (roles: string[]) => void; disabled?: boolean }) {
  const selected = ITEM_SUBROLES.filter((role) => value.some((entry) => normalizeAuctionRole(entry) === normalizeAuctionRole(role)));
  return <fieldset disabled={disabled} className="space-y-3 rounded-2xl border border-white/10 bg-slate-950/60 p-3">
    <legend className="px-1 text-xs font-semibold text-slate-300">Eligible subroles</legend>
    <p className="text-[11px] leading-5 text-slate-500">Choose up to two subroles, or Everyone for any linked toon.</p>
    <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
      {ITEM_SUBROLES.map((role) => {
        const checked = selected.includes(role);
        const unavailable = !checked && role !== 'Everyone' && !selected.includes('Everyone') && selected.length >= 2;
        return <label key={role} className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl border p-2.5 transition ${checked ? 'border-indigo-400/50 bg-indigo-500/15 shadow-lg shadow-indigo-950/20' : 'border-white/5 bg-white/[0.02] hover:border-white/20'} ${unavailable ? 'opacity-40' : ''}`}>
          <input type="checkbox" className="sr-only peer" checked={checked} disabled={unavailable} onChange={() => onChange(checked ? selected.filter((entry) => entry !== role) : role === 'Everyone' ? ['Everyone'] : [...selected.filter((entry) => entry !== 'Everyone'), role])} />
          <span className="rounded peer-focus-visible:outline-2 peer-focus-visible:outline-indigo-300"><RoleBadge role={role} gameClass /></span>
          <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? 'border-indigo-300 bg-indigo-400 text-slate-950' : 'border-slate-600'}`}>{checked && <Check size={12} />}</span>
        </label>;
      })}
    </div>
  </fieldset>;
}
