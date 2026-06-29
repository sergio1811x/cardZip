import type { RawProduct1688 } from '../types';
import { buildPriceDecision as buildDecisionPriceDecision } from './decisionLayer';

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

function positive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export function resolvePurchasePrice(product: RawProduct1688): ResolvedPurchasePrice {
  const decision = buildDecisionPriceDecision(product as any);
  const sourceMap: Record<string, PriceSource> = {
    sku: decision.selectedSkuPriceYuan ? 'selected_sku_price' : 'explicit_sku_price',
    price_range: 'discount_tier_min',
    fallback_min: 'price_range_min',
    promotion: 'promotion_price',
    direct: 'direct_price',
    missing: 'unknown',
  };
  const displayLabel = decision.priceSource === 'missing'
    ? '—'
    : decision.displayPriceText.replace(/^Цена:\s*/i, '').trim() || '—';
  return {
    valueCny: positive(decision.calculationPriceYuan),
    minCny: positive(decision.minPriceYuan),
    maxCny: positive(decision.maxPriceYuan),
    displayLabel,
    source: sourceMap[decision.priceSource] ?? 'unknown',
    isEstimated: decision.isEstimated,
    needsSkuConfirmation: decision.isSkuDependent || decision.isPackDependent || !decision.canCalculateRoi,
  };
}

export type PriceDecision = ReturnType<typeof buildDecisionPriceDecision>;
export function buildPriceDecision(product: RawProduct1688): PriceDecision {
  return buildDecisionPriceDecision(product as any);
}
