'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export default function Dialog({ children, onClose, busy = false, labelledBy, className = '' }: { children: ReactNode; onClose: () => void; busy?: boolean; labelledBy: string; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog?.showModal();
    return () => { dialog?.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  if (typeof document === 'undefined') return null;
  return <dialog ref={ref} aria-labelledby={labelledBy} aria-busy={busy} className={`app-dialog ${className}`} onCancel={(event) => { event.preventDefault(); if (!busy) closeRef.current(); }} onClick={(event) => { if (event.target === event.currentTarget && !busy) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeRef.current(); } }}>{children}</dialog>;
}
