import { createHash } from 'crypto';

/**
 * cache_key = sha256(productId:titleCn:mainImageUrl)
 * Включаем titleCn, чтобы сбрасывать кэш при редактировании листинга.
 */
export function buildCacheKey(
  productId: string,
  titleCn: string,
  mainImageUrl: string
): string {
  return createHash('sha256')
    .update(`${productId}:${titleCn}:${mainImageUrl}`)
    .digest('hex');
}
