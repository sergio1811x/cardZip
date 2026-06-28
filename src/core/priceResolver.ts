import type { RawProduct1688, PriceRange } from '../types';

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

function toPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string') {
    const normalized = value.replace(',', '.').replace(/[^\d.]/g, '');
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function firstPositive(values: unknown[]): number | null {
  for (const value of values) {
    const n = toPositiveNumber(value);
    if (n != null) return n;
  }
  return null;
}

function roundCny(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatCny(value: number): string {
  const rounded = roundCny(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function makeLabel(min: number, max?: number, suffix = ''): string {
  const safeMin = formatCny(min);
  const safeMax = max != null ? formatCny(max) : safeMin;
  const label = safeMin === safeMax ? `${safeMin} ¥` : `${safeMin}–${safeMax} ¥`;
  return suffix ? `${label} · ${suffix}` : label;
}

function normalizeRanges(ranges: PriceRange[] | undefined): Array<{ price: number; minQty?: number | null }> {
  const mapped = (ranges ?? []).map((r) => ({
    price: toPositiveNumber((r as any).price),
    minQty: toPositiveNumber((r as any).minQty ?? (r as any).min_quantity),
  }));
  const filtered: Array<{ price: number; minQty?: number | null }> = [];
  for (const r of mapped) {
    if (r.price != null) filtered.push({ price: r.price, minQty: r.minQty });
  }
  return filtered.sort((a, b) => a.price - b.price);
}

export function resolvePurchasePrice(product: RawProduct1688): ResolvedPurchasePrice {
  const pricing = product.normalized1688?.pricing;
  const skus = product.skus ?? [];
  const priceRanges = normalizeRanges(product.priceRange ?? pricing?.priceRanges);

  // 1. Selected SKU price (user picked a variant)
  const selectedSkuPrice = toPositiveNumber(pricing?.selectedSkuPriceYuan);
  if (selectedSkuPrice != null) {
    return {
      valueCny: roundCny(selectedSkuPrice),
      minCny: roundCny(selectedSkuPrice),
      maxCny: roundCny(selectedSkuPrice),
      displayLabel: makeLabel(selectedSkuPrice, selectedSkuPrice, pricing?.selectedSkuName || ''),
      source: 'selected_sku_price',
      isEstimated: false,
      needsSkuConfirmation: false,
    };
  }

  // 2. Explicit SKU prices (median of all valid SKU prices)
  const skuPrices = skus
    .map((s) => toPositiveNumber((s as any).price))
    .filter((p): p is number => p != null)
    .sort((a, b) => a - b);

  if (skuPrices.length > 0) {
    const minP = skuPrices[0];
    const maxP = skuPrices[skuPrices.length - 1];
    const mid = Math.floor(skuPrices.length / 2);
    const median = skuPrices.length % 2 ? skuPrices[mid] : (skuPrices[mid - 1] + skuPrices[mid]) / 2;
    return {
      valueCny: roundCny(median),
      minCny: roundCny(minP),
      maxCny: roundCny(maxP),
      displayLabel: makeLabel(minP, maxP, minP === maxP ? '' : 'уточнить выбранный SKU'),
      source: 'explicit_sku_price',
      isEstimated: minP !== maxP,
      needsSkuConfirmation: skuPrices.length > 1 || minP !== maxP,
    };
  }

  // 3. Discount/tier prices. Берём минимальную валидную цену, но помечаем как требующую подтверждения SKU/партии.
  if (priceRanges.length > 0) {
    const tierPrices = priceRanges.map((r) => r.price);
    const minTier = Math.min(...tierPrices);
    const maxTier = Math.max(...tierPrices);
    const hasQtyTiers = priceRanges.some((r) => (r.minQty ?? 0) > 1);
    return {
      valueCny: roundCny(minTier),
      minCny: roundCny(minTier),
      maxCny: roundCny(maxTier),
      displayLabel: makeLabel(minTier, maxTier, 'ориентир, уточнить SKU и объём партии'),
      source: hasQtyTiers ? 'discount_tier_min' : 'price_range_min',
      isEstimated: true,
      needsSkuConfirmation: true,
    };
  }

  // 4. Promotion price
  const promoPrice = toPositiveNumber(pricing?.promotionPriceYuan);
  if (promoPrice != null) {
    return {
      valueCny: roundCny(promoPrice),
      minCny: roundCny(promoPrice),
      maxCny: roundCny(promoPrice),
      displayLabel: makeLabel(promoPrice),
      source: 'promotion_price',
      isEstimated: false,
      needsSkuConfirmation: Boolean((product.skus ?? []).length > 1),
    };
  }

  // 5. Direct visible price. Важно: не используем ??, иначе 0 в normalized блокирует валидный product.priceYuan.
  const directPrice = firstPositive([
    pricing?.directPriceYuan,
    (product as any).priceYuan,
    (product as any).price,
  ]);
  if (directPrice != null) {
    return {
      valueCny: roundCny(directPrice),
      minCny: roundCny(directPrice),
      maxCny: roundCny(directPrice),
      displayLabel: makeLabel(directPrice),
      source: 'direct_price',
      isEstimated: false,
      needsSkuConfirmation: Boolean((product.skus ?? []).length > 1),
    };
  }

  // 6. No valid price at all
  return {
    valueCny: null,
    minCny: null,
    maxCny: null,
    displayLabel: 'не указана',
    source: 'unknown',
    isEstimated: false,
    needsSkuConfirmation: true,
  };
}
