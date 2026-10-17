'use client';

import { useEffect, useRef } from 'react';

/** One background request per visible view, with jitter and failure backoff. */
export function useAutoRefresh(refresh: () => Promise<unknown>, {
  active = true, intervalMs = 120_000, onError,
}: { active?: boolean; intervalMs?: number; onError?: (error: unknown) => void } = {}) {
  const latest = useRef({ refresh, onError });
  latest.current = { refresh, onError };
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let pending = false;
    let failures = 0;
    let lastAttempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      if (disposed) return;
      clearTimeout(timer);
      const delay = failures === 0 ? intervalMs : Math.min(600_000, 15_000 * 2 ** Math.min(failures - 1, 6));
      timer = setTimeout(() => void run(), Math.min(600_000, delay + Math.floor(Math.random() * delay * .15)));
    };
    const run = async (force = false) => {
      if (disposed || pending) return;
      if (document.visibilityState !== 'visible' || navigator.onLine === false) { schedule(); return; }
      if (!force && Date.now() - lastAttempt < 15_000) return;
      clearTimeout(timer);
      lastAttempt = Date.now(); pending = true;
      try { failures = await latest.current.refresh() === false ? failures + 1 : 0; }
      catch (error) { failures += 1; if (!disposed) latest.current.onError?.(error); }
      finally { pending = false; schedule(); }
    };
    const wake = () => { void run(); };
    const changed = () => { void run(true); };
    void run(true);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('centuri:dkp-changed', changed);
    window.addEventListener('centuri:catalog-changed', changed);
    return () => {
      disposed = true; clearTimeout(timer);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('centuri:dkp-changed', changed);
      window.removeEventListener('centuri:catalog-changed', changed);
    };
  }, [active, intervalMs]);
}
