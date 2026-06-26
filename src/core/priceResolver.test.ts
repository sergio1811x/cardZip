import { describe, it, expect } from 'vitest';
import { resolvePurchasePrice } from './priceResolver';
import type { RawProduct1688 } from '../types';

function makeProduct(overrides: Partial<RawProduct1688> = {}): RawProduct1688 {
  return {
    productId: '915601257818',
    platform: '1688',
    titleCn: 'Test',
    priceYuan: 0,
    moq: 1,
    weightKg: 0,
    images: [],
    mainImageUrl: '',
    supplierName: 'Test',
    ...overrides,
  } as RawProduct1688;
}

describe('resolvePurchasePrice', () => {
  it('returns null for product with no prices', () => {
    const result = resolvePurchasePrice(makeProduct());
    expect(result.valueCny).toBeNull();
    expect(result.source).toBe('unknown');
    expect(result.displayLabel).toBe('—');
  });

  it('resolves from discount tiers (offer 915601257818 case)', () => {
    const result = resolvePurchasePrice(makeProduct({
      priceRange: [
        { minQty: 1, maxQty: 199, price: 28 },
        { minQty: 200, maxQty: 499, price: 27 },
        { minQty: 500, maxQty: 0, price: 26 },
      ],
    }));
    expect(result.valueCny).toBe(26);
    expect(result.minCny).toBe(26);
    expect(result.maxCny).toBe(28);
    expect(result.source).toBe('discount_tier_min');
    expect(result.isEstimated).toBe(true);
    expect(result.needsSkuConfirmation).toBe(true);
    expect(result.displayLabel).toContain('26–28');
    expect(result.displayLabel).toContain('ориентир');
  });

  it('resolves from SKU prices', () => {
    const result = resolvePurchasePrice(makeProduct({
      skus: [
        { name: 'S black', price: 25 },
        { name: 'M black', price: 27 },
        { name: 'L black', price: 30 },
      ],
    }));
    expect(result.valueCny).toBe(27); // median
    expect(result.minCny).toBe(25);
    expect(result.maxCny).toBe(30);
    expect(result.source).toBe('explicit_sku_price');
  });

  it('resolves from selected SKU price', () => {
    const result = resolvePurchasePrice(makeProduct({
      normalized1688: {
        pricing: {
          quoteType: 'by_sku',
          displayPriceYuan: 27,
          selectedSkuName: 'M black',
          selectedSkuPriceYuan: 27,
          rawPriceFields: ['skus.price'],
        },
        skuCount: 3,
        skuVariants: [],
        imageCount: 0,
        images: [],
        attributes: [],
        keyAttributes: [],
        debug: { quoteType: 'by_sku', rawPriceFields: [], skuCount: 3, attributesCount: 0, imageCount: 0, extraInfoKeys: [], missingCriticalFields: [] },
      },
    }));
    expect(result.valueCny).toBe(27);
    expect(result.source).toBe('selected_sku_price');
    expect(result.isEstimated).toBe(false);
  });

  it('resolves from direct price', () => {
    const result = resolvePurchasePrice(makeProduct({ priceYuan: 42 }));
    expect(result.valueCny).toBe(42);
    expect(result.source).toBe('direct_price');
    expect(result.isEstimated).toBe(false);
  });

  it('treats 0 price as no price', () => {
    const result = resolvePurchasePrice(makeProduct({ priceYuan: 0 }));
    expect(result.valueCny).toBeNull();
  });
});
