import type { DkpCellIssue } from '@/lib/sheetRoster';

export default function RosterDataIssues({ issues = [] }: { issues?: DkpCellIssue[] }) {
  if (!issues.length) return null;
  return <details className="rounded-xl border border-amber-300/20 bg-amber-300/5 px-4 py-3 text-xs text-amber-100">
    <summary className="cursor-pointer font-medium">{issues.length} spreadsheet {issues.length === 1 ? 'cell needs' : 'cells need'} attention</summary>
    <p className="mt-3 leading-6 text-amber-100/70">Unavailable values appear as —. Posting and awards that do not use these cells can continue. Affected spending stays paused until the correct numbers are entered.</p>
    <ul className="mt-3 space-y-2">{issues.slice(0, 20).map((issue) => <li key={issue.cell} className="flex flex-wrap gap-2"><span className="font-semibold">{issue.cell}</span><span className="break-all text-amber-100/70">contains “{issue.value}”</span></li>)}</ul>
    {issues.length > 20 && <p className="mt-3 text-amber-100/70">And {issues.length - 20} more cells.</p>}
    <p className="mt-3 leading-6 text-amber-100/70">Check the source cells and column headings in DKP_Sheet_automated. Class and rank letters must not replace DKP amounts.</p>
  </details>;
}
