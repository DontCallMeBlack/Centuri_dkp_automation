export default function LoadingSurface({
  rows = 5,
  label = 'Preparing your workspace',
  fullLayout = false,
  title,
}: {
  rows?: number;
  label?: string;
  fullLayout?: boolean;
  title?: string;
}) {
  if (!fullLayout) {
    return <section className="surface skeleton-surface page-loading page-loading-compact" role="status" aria-label={label} aria-busy="true"><span className="sr-only">{label}</span><div className="skeleton mb-3 h-4 w-24" /><div className="skeleton mb-8 h-7 w-52" /><div className="space-y-3">{Array.from({ length: rows }, (_, i) => <div key={i} className="flex items-center gap-4 border-t border-white/5 pt-3"><div className="skeleton h-10 w-10 rounded-xl" /><div className="skeleton h-4 w-1/3" /><div className="skeleton ml-auto h-4 w-16" /></div>)}</div></section>;
  }

  return (
    <section className="page-loading page-loading-full space-y-6" role="status" aria-label={label} aria-busy="true">
      <span className="sr-only">{label}</span>
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <div className="skeleton mb-3 h-3 w-28" />
          {title ? <h1 className="page-title">{title}</h1> : <div className="skeleton h-8 w-64 max-w-full" />}
          <div className="skeleton mt-3 h-4 w-80 max-w-full" />
        </div>
        <div className="skeleton h-10 w-36 rounded-xl" />
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((key) => <div key={key} className="surface stat-card"><div className="skeleton h-3 w-24" /><div className="skeleton mt-3 h-6 w-16" /><div className="skeleton mt-2 h-3 w-28" /></div>)}
      </div>

      <section className="surface space-y-5 p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div><div className="skeleton h-5 w-40" /><div className="skeleton mt-2 h-3 w-56" /></div>
          <div className="skeleton h-10 w-full rounded-xl sm:max-w-xs" />
        </div>
        <div className="flex gap-2 overflow-hidden border-b border-white/5 pb-3">
          {[0, 1, 2, 3].map((key) => <div key={key} className="skeleton h-9 w-28 shrink-0 rounded-lg" />)}
        </div>
        <div className="space-y-3" aria-hidden="true">
          {Array.from({ length: rows }, (_, i) => <div key={i} className="flex min-w-0 items-center gap-3 rounded-xl border border-white/5 bg-slate-950/30 p-3 sm:gap-4 sm:p-4"><div className="skeleton h-10 w-10 shrink-0 rounded-xl" /><div className="min-w-0 flex-1"><div className="skeleton h-4 w-2/5" /><div className="skeleton mt-2 h-3 w-1/4" /></div><div className="skeleton hidden h-4 w-20 sm:block" /><div className="skeleton h-8 w-16 shrink-0 rounded-lg" /></div>)}
        </div>
      </section>
    </section>
  );
}
