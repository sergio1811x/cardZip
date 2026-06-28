import { createHash } from 'crypto';

function normalizeCachePart(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 2_000);
}

/**
 * cache_key = sha256(productId:titleCn:mainImageUrl)
 * Включаем titleCn, чтобы сбрасывать кэш при редактировании листинга.
 */
export function buildCacheKey(
  productId: string,
  titleCn: string,
  mainImageUrl: string
): string {
  const payload = [productId, titleCn, mainImageUrl].map(normalizeCachePart).join(':');
  return createHash('sha256').update(payload).digest('hex');
}
