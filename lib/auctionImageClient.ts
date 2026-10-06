export async function optimizeImageForUpload(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 40_000_000) {
      throw new Error(`${file.name} is too large to process in the browser.`);
    }

    const variants = [
      { width: 1200, quality: 0.78 },
      { width: 1000, quality: 0.74 },
      { width: 900, quality: 0.68 },
      { width: 800, quality: 0.62 },
      { width: 700, quality: 0.55 },
    ] as const;

    for (const { width, quality } of variants) {
      const scale = Math.min(1, width / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Your browser could not prepare the selected image.');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/webp', quality),
      );
      if (blob?.type === 'image/webp' && blob.size <= 256 * 1024) {
        const filename = file.name.replace(/\.[^.]+$/, '') || 'auction-item';
        return new File([blob], `${filename}.webp`, { type: 'image/webp' });
      }
    }

    throw new Error(`${file.name} could not be compressed enough. Choose a smaller or simpler image.`);
  } finally {
    bitmap.close();
  }
}
