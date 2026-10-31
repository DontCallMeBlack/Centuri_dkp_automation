'use client';

import Link from 'next/link';

export default function ErrorPage() {
  return <section className="surface mx-auto max-w-lg p-8 text-center"><h1 className="text-xl font-semibold tracking-tight text-slate-100">Centuri could not load this section.</h1><p className="mt-3 text-xs leading-6 text-slate-400">Your data is unchanged. Return to the dashboard and continue from there.</p><Link className="primary-button mt-6" href="/dashboard">Back to dashboard</Link></section>;
}
