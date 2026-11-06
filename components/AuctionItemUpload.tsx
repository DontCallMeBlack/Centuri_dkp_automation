'use client';

import { useEffect, useRef, useState } from 'react';
import Dialog from '@/components/Dialog';
import { ImagePlus, LoaderCircle } from 'lucide-react';
import { resolveItemSubroles } from '@/lib/auctionRules';
import { optimizeImageForUpload } from '@/lib/auctionImageClient';

function SquareImageCropStep({
  file,
  step,
  total,
  onComplete,
  onCancel,
}: {
  file: File;
  step: number;
  total: number;
  onComplete: (croppedFile: File) => void;
  onCancel: () => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragOrigin = useRef<{ pointerX: number; pointerY: number; cropX: number; cropY: number; scale: number } | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0, zoom: 1 });
  const [frameSize, setFrameSize] = useState(320);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
      setCrop({
        x: Math.max(0, (image.naturalWidth - Math.min(image.naturalWidth, image.naturalHeight)) / 2),
        y: Math.max(0, (image.naturalHeight - Math.min(image.naturalWidth, image.naturalHeight)) / 2),
        zoom: 1,
      });
      setSourceUrl(url);
    };
    image.onerror = () => setError('This image could not be opened. Choose another image.');
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !('ResizeObserver' in window)) return;
    const observer = new ResizeObserver(([entry]) => setFrameSize(entry.contentRect.width));
    observer.observe(frame);
    return () => observer.disconnect();
  }, [sourceUrl]);

  const shortSide = dimensions ? Math.min(dimensions.width, dimensions.height) : 1;
  const cropSide = shortSide / crop.zoom;
  const scale = frameSize / cropSide;
  const clamp = (value: number, maximum: number) => Math.min(Math.max(value, 0), maximum);

  const setZoom = (zoom: number) => {
    if (!dimensions) return;
    const boundedZoom = Math.min(3, Math.max(1, zoom));
    const nextSide = shortSide / boundedZoom;
    const centerX = crop.x + cropSide / 2;
    const centerY = crop.y + cropSide / 2;
    setCrop({
      x: clamp(centerX - nextSide / 2, dimensions.width - nextSide),
      y: clamp(centerY - nextSide / 2, dimensions.height - nextSide),
      zoom: boundedZoom,
    });
  };

  const finishCrop = async () => {
    if (!dimensions || !imageRef.current || processing) return;
    setProcessing(true);
    setError('');
    try {
      await imageRef.current.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 768;
      canvas.height = 768;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Your browser could not prepare this crop.');
      context.drawImage(imageRef.current, crop.x, crop.y, cropSide, cropSide, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.92));
      if (!blob) throw new Error('Your browser could not create this crop.');
      const baseName = file.name.replace(/\.[^.]+$/, '') || 'auction-item';
      onComplete(new File([blob], `${baseName}-square.webp`, { type: 'image/webp' }));
    } catch (cropError) {
      setError(cropError instanceof Error ? cropError.message : 'Unable to crop this image.');
      setProcessing(false);
    }
  };

  return (
    <Dialog labelledBy="square-crop-title" busy={processing} onClose={onCancel} className="!max-w-lg">
      <div className="w-full max-w-lg rounded-3xl border border-indigo-300/20 bg-slate-950 p-4 shadow-2xl shadow-black/50 sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-indigo-300">Image framing · {step} of {total}</p>
            <h3 id="square-crop-title" className="mt-1 text-lg font-black text-white">Choose the item crop</h3>
            <p className="mt-1 text-xs text-slate-400">Drag the image to frame the item. Use zoom to adjust the crop size.</p>
          </div>
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800">Cancel</button>
        </div>

        <div
          ref={frameRef}
          role="img"
          aria-label="Image crop. Use arrow keys to move the image; adjust zoom with the slider below."
          tabIndex={0}
          onKeyDown={(event) => {
            if (!dimensions || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const step = cropSide * (event.shiftKey ? 0.1 : 0.02);
            setCrop((current) => ({...current,x:clamp(current.x+(event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),dimensions.width-cropSide),y:clamp(current.y+(event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),dimensions.height-cropSide)}));
          }}
          className="relative mx-auto aspect-square w-[min(80vw,320px)] touch-none cursor-grab overflow-hidden rounded-2xl border-2 border-indigo-300/70 bg-slate-900 shadow-[0_0_35px_rgba(99,102,241,0.15)] active:cursor-grabbing"
          onPointerDown={(event) => {
            if (!dimensions) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            dragOrigin.current = { pointerX: event.clientX, pointerY: event.clientY, cropX: crop.x, cropY: crop.y, scale };
          }}
          onPointerMove={(event) => {
            const origin = dragOrigin.current;
            if (!origin || !dimensions) return;
            setCrop((current) => ({
              ...current,
              x: clamp(origin.cropX - (event.clientX - origin.pointerX) / origin.scale, dimensions.width - cropSide),
              y: clamp(origin.cropY - (event.clientY - origin.pointerY) / origin.scale, dimensions.height - cropSide),
            }));
          }}
          onPointerUp={() => { dragOrigin.current = null; }}
          onPointerCancel={() => { dragOrigin.current = null; }}
        >
          {sourceUrl && dimensions ? (
            <img
              ref={imageRef}
              src={sourceUrl}
              alt="Move and zoom to select the square item crop"
              draggable={false}
              className="pointer-events-none absolute max-w-none select-none"
              style={{ width: dimensions.width * scale, height: dimensions.height * scale, left: -crop.x * scale, top: -crop.y * scale }}
            />
          ) : <LoaderCircle className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 animate-spin text-indigo-300" />}
          <div className="pointer-events-none absolute inset-0 border border-white/40" />
          <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/65 px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-white">Square preview</span>
        </div>

        <label className="mt-5 block space-y-2 text-xs font-semibold text-slate-300">
          <span className="flex items-center justify-between"><span>Zoom</span><span className="font-mono text-indigo-200">{crop.zoom.toFixed(1)}×</span></span>
          <input type="range" min="1" max="3" step="0.05" value={crop.zoom} onChange={(event) => setZoom(Number(event.target.value))} className="w-full accent-indigo-400" />
        </label>
        {error && <p role="alert" className="mt-3 text-xs text-rose-300">{error}</p>}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onCancel} className="flex-1 rounded-xl border border-slate-700 px-4 py-3 text-sm font-bold text-slate-300 hover:bg-slate-900">Cancel images</button>
          <button type="button" disabled={!dimensions || processing} onClick={() => void finishCrop()} className="flex-1 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-3 text-sm font-black text-white shadow-lg shadow-indigo-950/40 hover:from-indigo-400 hover:to-violet-400 disabled:opacity-50">
            {processing ? <span className="inline-flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin" /> Preparing…</span> : step < total ? 'Use crop · Next image' : 'Use square crop'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function SquareImageUpload({
  files,
  onChange,
  label,
  multiple = true,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  label: string;
  multiple?: boolean;
}) {
  const [queue, setQueue] = useState<File[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [croppedFiles, setCroppedFiles] = useState<File[]>([]);
  const [cropperOpen, setCropperOpen] = useState(false);
  const [selectionError, setSelectionError] = useState('');

  const beginCrop = (selectedFiles: File[]) => {
    setSelectionError('');
    if (multiple && selectedFiles.length > 8) {
      setSelectionError('Choose no more than 8 images at a time.');
      return;
    }
    const selection = multiple ? selectedFiles : selectedFiles.slice(0, 1);
    if (!selection.length) return;
    setQueue(selection);
    setQueueIndex(0);
    setCroppedFiles([]);
    setCropperOpen(true);
  };

  const completeCurrentCrop = (file: File) => {
    const nextFiles = [...croppedFiles, file];
    if (queueIndex + 1 < queue.length) {
      setCroppedFiles(nextFiles);
      setQueueIndex((index) => index + 1);
      return;
    }
    onChange(nextFiles);
    setCropperOpen(false);
    setQueue([]);
  };

  return (
    <>
      <label className="flex cursor-pointer items-center gap-2 overflow-hidden rounded-xl border border-dashed border-slate-700 bg-slate-950 px-3.5 py-3 text-sm text-slate-300 transition hover:border-indigo-400/50 hover:bg-indigo-400/[0.04]">
        <ImagePlus className="h-4 w-4 shrink-0 text-indigo-300" />
        <span className="truncate">{label}</span>
        <input type="file" accept="image/png,image/jpeg,image/webp" multiple={multiple} onChange={(event) => { beginCrop(Array.from(event.target.files ?? [])); event.currentTarget.value = ''; }} className="sr-only" />
      </label>
      {selectionError && <p role="alert" className="text-[10px] text-rose-300">{selectionError}</p>}
      {cropperOpen && queue[queueIndex] && <SquareImageCropStep key={`${queueIndex}-${queue[queueIndex].name}-${queue[queueIndex].lastModified}`} file={queue[queueIndex]} step={queueIndex + 1} total={queue.length} onComplete={completeCurrentCrop} onCancel={() => { setCropperOpen(false); setQueue([]); setCroppedFiles([]); }} />}
      {files.length > 0 && <p className="text-[10px] text-emerald-300">{files.length} square-cropped image{files.length === 1 ? '' : 's'} ready</p>}
    </>
  );
}

export async function buildItemForm(name: string, requiredRoles: string[], bossType: string, files: File[]) {
  const subroles = resolveItemSubroles(requiredRoles);
  if (!subroles) throw new Error('Choose one or two subroles with icons, or Everyone on its own.');
  const optimizedFiles = await Promise.all(files.map(optimizeImageForUpload));
  const totalUploadBytes = optimizedFiles.reduce((total, file) => total + file.size, 0);
  if (totalUploadBytes > 2 * 1024 * 1024) {
    throw new Error('The optimized images exceed 2 MB total. Remove an image and try again.');
  }

  const form = new FormData();
  form.set('name', name);
  for (const role of subroles) form.append('requiredRoles', role);
  form.set('bossType', bossType);
  for (const file of optimizedFiles) form.append('images', file);
  return form;
}

