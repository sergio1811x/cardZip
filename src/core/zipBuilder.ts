import AdmZip from 'adm-zip';
import type { ZipBuilder } from '../types';

const DEFAULT_MAX_IMAGES = 15;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    return Buffer.from(buffer);
  } catch {
    return null; // фото не скачалось — пропускаем
  }
}

function guessExtension(url: string): string {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  if (ext && ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return ext;
  return 'jpg';
}

async function buildFromUrls(
  imageUrls: string[],
  options?: { maxImages?: number; maxSizeBytes?: number }
): Promise<Buffer> {
  const maxImages = options?.maxImages ?? DEFAULT_MAX_IMAGES;
  const maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_BYTES;

  const urls = imageUrls.slice(0, maxImages);

  const results = await Promise.race([
    Promise.all(urls.map(downloadImage)),
    new Promise<(Buffer | null)[]>((_, reject) =>
      setTimeout(() => reject(new Error('ZIP build timeout')), 30_000)
    ),
  ]).catch(() => urls.map(() => null as Buffer | null));

  const zip = new AdmZip();
  let totalSize = 0;
  let count = 0;

  for (let i = 0; i < results.length; i++) {
    const buf = results[i];
    if (!buf) continue;

    if (totalSize + buf.length > maxSizeBytes) {
      console.warn(`[zip] Превышен лимит ${maxSizeBytes} байт, остановились на фото ${count}`);
      break;
    }

    const ext = guessExtension(urls[i]);
    zip.addFile(`image_${String(count + 1).padStart(2, '0')}.${ext}`, buf);
    totalSize += buf.length;
    count++;
  }

  console.log(`[zip] Собран архив: ${count} фото, ${Math.round(totalSize / 1024)} KB`);
  return zip.toBuffer();
}

export const zipBuilder: ZipBuilder = { buildFromUrls };
