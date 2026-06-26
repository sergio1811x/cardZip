import type { RawProduct1688, PriceRange, ProductSku } from '../types';

export type PriceSource =
  | 'selected_sku_price'
  | 'explicit_sku_price'
  | 'discount_tier_min'
  | 'price_range_min'
  | 'promotion_price'
  | 'direct_price'
  | 'manual_supplier_answer'
  | 'unknown';

export interface ResolvedPurchasePrice {
  valueCny: number | null;
  minCny: number | null;
  maxCny: number | null;
  displayLabel: string;
  source: PriceSource;
  isEstimated: boolean;
  needsSkuConfirmation: boolean;
}

export function resolvePurchasePrice(product: RawProduct1688): ResolvedPurchasePrice {
  const pricing = product.normalized1688?.pricing;
  const skus = product.skus ?? [];
  const priceRanges = product.priceRange ?? pricing?.priceRanges ?? [];

  // 1. Selected SKU price (user picked a variant)
  if (pricing?.selectedSkuPriceYuan && pricing.selectedSkuPriceYuan > 0) {
    return {
      valueCny: pricing.selectedSkuPriceYuan,
      minCny: pricing.selectedSkuPriceYuan,
      maxCny: pricing.selectedSkuPriceYuan,
      displayLabel: `${pricing.selectedSkuPriceYuan} ¥` + (pricing.selectedSkuName ? ` · ${pricing.selectedSkuName}` : ''),
      source: 'selected_sku_price',
      isEstimated: false,
      needsSkuConfirmation: false,
    };
  }

  // 2. Explicit SKU prices (median of all SKU prices)
  const skuPrices = skus.map(s => s.price).filter((p): p is number => p != null && p > 0).sort((a, b) => a - b);
  if (skuPrices.length > 0) {
    const minP = skuPrices[0];
    const maxP = skuPrices[skuPrices.length - 1];
    const mid = Math.floor(skuPrices.length / 2);
    const median = skuPrices.length % 2 ? skuPrices[mid] : (skuPrices[mid - 1] + skuPrices[mid]) / 2;
    return {
      valueCny: median,
      minCny: minP,
      maxCny: maxP,
      displayLabel: minP === maxP ? `${minP} ¥` : `${minP}–${maxP} ¥`,
      source: 'explicit_sku_price',
      isEstimated: minP !== maxP,
      needsSkuConfirmation: skuPrices.length > 1,
    };
  }

  // 3. Discount tier prices (1+ → 28¥, 200+ → 27¥, 500+ → 26¥)
  const tierPrices = priceRanges.filter(r => r.price > 0).map(r => r.price);
  if (tierPrices.length > 0) {
    const minTier = Math.min(...tierPrices);
    const maxTier = Math.max(...tierPrices);
    return {
      valueCny: minTier,
      minCny: minTier,
      maxCny: maxTier,
      displayLabel: minTier === maxTier
        ? `${minTier} ¥`
        : `${minTier}–${maxTier} ¥ · ориентир, уточнить SKU`,
      source: 'discount_tier_min',
      isEstimated: true,
      needsSkuConfirmation: true,
    };
  }

  // 4. Promotion price
  const promoPrice = pricing?.promotionPriceYuan;
  if (promoPrice && promoPrice > 0) {
    return {
      valueCny: promoPrice,
      minCny: promoPrice,
      maxCny: promoPrice,
      displayLabel: `${promoPrice} ¥`,
      source: 'promotion_price',
      isEstimated: false,
      needsSkuConfirmation: false,
    };
  }

  // 5. Direct price
  const directPrice = pricing?.directPriceYuan ?? product.priceYuan;
  if (directPrice && directPrice > 0) {
    return {
      valueCny: directPrice,
      minCny: directPrice,
      maxCny: directPrice,
      displayLabel: `${directPrice} ¥`,
      source: 'direct_price',
      isEstimated: false,
      needsSkuConfirmation: false,
    };
  }

  // 6. No price at all
  return {
    valueCny: null,
    minCny: null,
    maxCny: null,
    displayLabel: '—',
    source: 'unknown',
    isEstimated: false,
    needsSkuConfirmation: false,
  };
}
