import Link from 'next/link';
import { Compass } from 'lucide-react';

export default function NotFound() {
  return <section className="surface mx-auto max-w-lg p-8 text-center">
    <Compass className="mx-auto text-amber-200" size={32} />
    <p className="page-kicker mt-6 justify-center">404 · Page not found</p>
    <h1 className="mt-4 text-2xl font-semibold text-white">Let’s get you back to the clan.</h1>
    <p className="mt-3 text-sm leading-6 text-slate-400">This address may have changed. Open the roster to find your toons, auctions, and raid history.</p>
    <Link className="primary-button mt-6" href="/dashboard">Go to roster</Link>
  </section>;
}
