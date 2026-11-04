'use client';

import { useState } from 'react';
import { Search } from 'lucide-react';
import { matchAttendeeNames, type AttendeeNameMatches, type AttendeeRosterRecord } from '@/lib/attendeeNames';

interface AttendeeSearchProps {
  roster: AttendeeRosterRecord[];
  value: string;
  onChange: (value: string) => void;
  onAddRows: (rows: number[]) => void;
  disabled?: boolean;
}

export default function AttendeeSearch({ roster, value, onChange, onAddRows, disabled }: AttendeeSearchProps) {
  const [result, setResult] = useState<AttendeeNameMatches | null>(null);
  const addNames = (text: string) => {
    const matches = matchAttendeeNames(text, roster);
    onAddRows(matches.rows);
    onChange('');
    setResult(matches);
  };
  return <div className="mb-3">
    <label className="relative block">
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
      <input
        type="search"
        aria-label="Search attendees or paste toon names"
        placeholder="Search or paste space-separated toon names..."
        autoComplete="off"
        value={value}
        disabled={disabled}
        onChange={(event) => { setResult(null); onChange(event.target.value); }}
        onPaste={(event) => {
          const text = event.clipboardData.getData('text');
          if (disabled || !text.trim()) return;
          event.preventDefault();
          addNames(text);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || !/\S\s+\S/u.test(value)) return;
          event.preventDefault();
          addNames(value);
        }}
        className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950/60 pl-9 pr-3 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-indigo-400 disabled:opacity-60"
      />
    </label>
    <p className="mt-1.5 text-[11px] text-slate-500">Paste names to select attendees. Close spellings match at 90% similarity.</p>
    {result && <div role="status" className="mt-2 space-y-1 break-words rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-300">
      <p>{result.matchedCount} name{result.matchedCount === 1 ? '' : 's'} matched. Review selected attendees before saving.</p>
      {result.fuzzy.length > 0 && <p className="text-indigo-200">Close matches: {result.fuzzy.map((match) => `${match.input} → ${match.name} (${Math.round(match.similarity * 100)}%)`).join(', ')}</p>}
      {result.unmatched.length > 0 && <p className="text-amber-200">Not found: {result.unmatched.join(', ')}</p>}
      {result.ambiguous.length > 0 && <p className="text-amber-200">Multiple matches; select manually: {result.ambiguous.join(', ')}</p>}
    </div>}
  </div>;
}
