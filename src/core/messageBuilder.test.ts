import { describe, it, expect } from 'vitest';
import { buildMainMessage, build1688Detail, buildEconomicsDetail } from './messageBuilder';
import type { ProductWithContent, EconomicsResult, EconomicsBreakdown } from '../types';

const FORBIDDEN_PATTERNS = [
  /Цена: 0 ¥/,
  /Вес: 0 кг/,
  /0\.37754\d+/,
  /undefined/,
  /\bnull\b/,
  /\bNaN\b/,
  /цена не распознана/i,
];

function makeEconomics(overrides: Partial<EconomicsResult> = {}): EconomicsResult {
  const breakdown: EconomicsBreakdown = {
    purchaseYuan: 26, purchaseRub: 307, bankMarkupRub: 9, cargoRub: 114,
    internalLogisticsRub: 80, wbCommissionRub: 279, wbLogisticsRub: 100,
    taxRub: 98, drrRub: 209, drrPercent: 15,
  };
  return {
    yuanToRub: 11.8, platformMode: 'full', breakdown, costRub: 510,
    avgSaleRub: 1395, grossProfitRub: 199, grossMarginPercent: 14, roiPercent: 39,
    weightMissing: false, isCustomTariffs: false, isSyntheticPrice: false, disclaimer: '',
    ...overrides,
  };
}

function makeProduct(overrides: Partial<ProductWithContent> = {}): ProductWithContent {
  return {
    productId: '915601257818',
    platform: '1688',
    titleCn: '女式瑜伽健身连体衣',
    titleRu: 'Женский фитнес-комбинезон',
    priceYuan: 26,
    moq: 1,
    weightKg: 0.3,
    images: ['img1.jpg'],
    mainImageUrl: 'img1.jpg',
    supplierName: 'Test Supplier',
    priceRange: [
      { minQty: 1, maxQty: 199, price: 28 },
      { minQty: 200, maxQty: 499, price: 27 },
      { minQty: 500, maxQty: 0, price: 26 },
    ],
    economics: makeEconomics(),
    conclusion: { platform: '1688', icon: '🟢', headline: 'Test', disclaimers: [] },
    ...overrides,
  } as ProductWithContent;
}

describe('buildMainMessage snapshot test', () => {
  it('does not contain forbidden patterns for normal product', () => {
    const product = makeProduct();
    const { text } = buildMainMessage(product, 'job123', { plan: 'free', creditsRemaining: 3, creditsTotal: 3, canGenerate: true, isTrial: true });
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(text).not.toMatch(pattern);
    }
  });

  it('does not contain forbidden patterns for zero-price product', () => {
    const product = makeProduct({ priceYuan: 0, priceRange: undefined });
    const { text } = buildMainMessage(product, 'job123', { plan: 'free', creditsRemaining: 3, creditsTotal: 3, canGenerate: true, isTrial: true });
    expect(text).not.toMatch(/Цена: 0 ¥/);
    expect(text).not.toMatch(/undefined/);
  });

  it('does not contain forbidden patterns for zero-weight product', () => {
    const product = makeProduct({
      weightKg: 0,
      economics: makeEconomics({ weightMissing: true, categoryDefaultWeightKg: 0.3, weightSource: 'category_default' }),
    });
    const { text } = buildMainMessage(product, 'job123', { plan: 'free', creditsRemaining: 3, creditsTotal: 3, canGenerate: true, isTrial: true });
    expect(text).not.toMatch(/Вес: 0 кг/);
    expect(text).not.toMatch(/undefined/);
  });

  it('shows selected price in header for a priced product', () => {
    const product = makeProduct({ priceYuan: 26 });
    const { text } = buildMainMessage(product, 'job123', { plan: 'free', creditsRemaining: 3, creditsTotal: 3, canGenerate: true, isTrial: true });
    expect(text).toMatch(/26/);
  });

  it('asks to clarify price when no prices at all', () => {
    const product = makeProduct({ priceYuan: 0, priceRange: undefined, skus: undefined });
    const { text } = buildMainMessage(product, 'job123', { plan: 'free', creditsRemaining: 3, creditsTotal: 3, canGenerate: true, isTrial: true });
    expect(text).toContain('Цена: нужно уточнить');
  });
});

describe('build1688Detail snapshot test', () => {
  it('does not show 0 ¥ or 0 кг', () => {
    const product = makeProduct({ priceYuan: 0, weightKg: 0, priceRange: undefined });
    const { text } = build1688Detail(product, 'job123');
    expect(text).not.toMatch(/: 0 ¥/);
    expect(text).not.toMatch(/: 0 кг/);
    expect(text).not.toMatch(/0\.37754/);
  });
});

describe('buildEconomicsDetail snapshot test', () => {
  it('does not show raw 0 values', () => {
    const product = makeProduct({
      priceYuan: 0,
      priceRange: undefined,
      economics: makeEconomics({ costRub: 0, breakdown: { purchaseYuan: 0, purchaseRub: 0, bankMarkupRub: 0, cargoRub: 0, internalLogisticsRub: 0, wbCommissionRub: 0, wbLogisticsRub: 0, taxRub: 0, drrRub: 0, drrPercent: 15 } }),
    });
    const { text } = buildEconomicsDetail(product, 'job123');
    expect(text).not.toMatch(/: 0 ¥/);
  });
});
