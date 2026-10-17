'use client';

import { RefreshCw, ShieldAlert } from 'lucide-react';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <section className="surface mx-auto max-w-lg p-8 text-center"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-amber-300/15 bg-amber-300/5 text-amber-200"><ShieldAlert size={22} /></span><h1 className="mt-5 text-xl font-semibold tracking-tight text-slate-100">This page needs another try.</h1><p className="mt-3 text-xs leading-6 text-slate-400">We could not display the page. If you were submitting a DKP action, check the history before starting another one.</p><button type="button" className="primary-button mt-6" onClick={reset}><RefreshCw size={15} />Try again</button></section>;
}
