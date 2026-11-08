'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ImageOff, Sparkles } from 'lucide-react';
import { auctionImageUrl } from '@/lib/auctionImageUrl';

export default function AuctionItemImage({ itemId, imageCount, imageVersion, alt, className, showNavigation = true, showNameOnError = false }: {itemId:string; imageCount:number; imageVersion?:string; alt:string; className:string; showNavigation?:boolean; showNameOnError?:boolean}) {
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const [imageIndex, setImageIndex] = useState(0);
  const [readyItemId, setReadyItemId] = useState<string | null>(null);
  const [loadedSource, setLoadedSource] = useState<string | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const total = Math.max(1,imageCount);
  const source = auctionImageUrl(itemId, imageIndex, imageVersion);
  const shouldLoad = readyItemId === itemId;
  const loaded = loadedSource === source;
  const failed = failedSource === source;

  useEffect(() => {
    setImageIndex(0);
    const container = imageContainerRef.current;
    if (!container) return;
    if (!('IntersectionObserver' in window)) {
      setReadyItemId(itemId);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setReadyItemId(itemId);
        observer.disconnect();
      }
    }, { rootMargin: '220px 0px' });
    observer.observe(container);
    return () => observer.disconnect();
  }, [itemId, imageVersion]);

  const changeImage = (index:number) => setImageIndex(index);
  return <div className={`${className} relative overflow-hidden`}>
    <div ref={imageContainerRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />
    {!failed && shouldLoad && <img src={source} alt={`${alt}, image ${imageIndex+1}`} loading="lazy" decoding="async" onLoad={() => setLoadedSource(source)} onError={() => setFailedSource(source)} className={`h-full w-full object-cover transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`} />}
    {!loaded && !failed && <div className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.2)_0%,rgba(15,23,42,0.92)_58%,rgba(2,6,23,1)_100%)]" aria-hidden="true">
      <div className="absolute inset-x-[18%] top-1/2 h-px bg-gradient-to-r from-transparent via-amber-200/35 to-transparent" />
      <div className="relative grid h-9 w-9 place-items-center rounded-2xl border border-amber-200/25 bg-slate-950/55 text-amber-200 shadow-[0_0_28px_rgba(251,191,36,0.16)] animate-pulse">
        <Sparkles className="h-4 w-4" />
      </div>
    </div>}
    {failed && <div role="img" aria-label={`${alt}: image unavailable`} className="flex h-full min-h-10 flex-col items-center justify-center gap-1 text-[9px] text-slate-500"><ImageOff size={17} />{showNameOnError && <span className="max-w-full break-words px-3 text-center text-sm font-semibold text-slate-200">{alt}</span>}<span>Image unavailable</span></div>}
    {showNavigation && total > 1 && <ImageNavigation imageIndex={imageIndex} imageTotal={total} setImageIndex={changeImage} />}
  </div>;
}

function ImageNavigation({
  imageIndex,
  imageTotal,
  setImageIndex,
}: {
  imageIndex: number;
  imageTotal: number;
  setImageIndex: (index: number) => void;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Previous item image"
        onClick={() => setImageIndex((imageIndex + imageTotal - 1) % imageTotal)}
        className="absolute left-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-slate-950/80 text-white shadow-lg backdrop-blur hover:bg-slate-800"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="absolute bottom-1 right-1 rounded-full border border-white/10 bg-slate-950/80 px-2 py-0.5 text-[10px] font-semibold text-white shadow-lg">
        {imageIndex + 1}/{imageTotal}
      </span>
      <button
        type="button"
        aria-label="Next item image"
        onClick={() => setImageIndex((imageIndex + 1) % imageTotal)}
        className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-slate-950/80 text-white shadow-lg backdrop-blur hover:bg-slate-800"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </>
  );
}

