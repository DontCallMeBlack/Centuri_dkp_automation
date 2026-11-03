'use client';

import { useEffect, useRef } from 'react';

/** Load once and after local changes; time, focus, and visibility do not refetch. */
export function useManualRefresh(refresh: (force: boolean) => Promise<unknown>, active = true) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let pending = false;
    let queued = false;
    const run = async (force: boolean) => {
      if (disposed) return;
      if (pending) { queued ||= force; return; }
      pending = true;
      try { await latest.current(force); }
      finally {
        pending = false;
        if (queued && !disposed) { queued = false; void run(true); }
      }
    };
    const changed = () => { void run(true); };
    void run(false);
    window.addEventListener('centuri:dkp-changed', changed);
    window.addEventListener('centuri:catalog-changed', changed);
    return () => {
      disposed = true;
      window.removeEventListener('centuri:dkp-changed', changed);
      window.removeEventListener('centuri:catalog-changed', changed);
    };
  }, [active]);
}
