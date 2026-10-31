import { Search } from 'lucide-react';

export default function EmptyState({ title, description, onReset }: { title: string; description?: string; onReset?: () => void }) {
  return <div className="empty-state">
    <span className="empty-state-icon" aria-hidden="true"><Search size={23} /></span>
    <h3 className="text-base font-semibold text-slate-100">{title}</h3>
    {description && <p className="mt-2 max-w-md text-sm leading-6 text-slate-400">{description}</p>}
    {onReset && <button type="button" className="secondary-button mt-5" onClick={onReset}>Clear search and filters</button>}
  </div>;
}
