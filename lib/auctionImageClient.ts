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
      { width: 600, quality: 0.50 },
      { width: 512, quality: 0.48 },
      { width: 384, quality: 0.44 },
      { width: 256, quality: 0.40 },
      { width: 192, quality: 0.38 },
    ] as const;

    for (const { width, quality } of variants) {
      const scale = Math.min(1, width / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Your browser could not prepare the selected image.');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      for (const format of ['image/webp', 'image/jpeg']) {
        if (format === 'image/jpeg') {
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        }
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, format, quality),
        );
        // Browsers without WebP encoding return PNG instead of the requested type.
        const extension = blob && ({ 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' } as Record<string, string>)[blob.type];
        if (blob && extension && blob.size > 0 && blob.size <= 256 * 1024) {
          const filename = file.name.replace(/\.[^.]+$/, '') || 'auction-item';
          return new File([blob], `${filename}.${extension}`, { type: blob.type });
        }
      }
    }

    throw new Error(`${file.name} could not be compressed enough. Choose a smaller or simpler image.`);
  } finally {
    bitmap.close();
  }
}
