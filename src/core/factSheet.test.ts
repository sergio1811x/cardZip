import { describe, expect, it } from 'vitest';
import { buildProductFactSheet } from './factSheet';
import type { RawProduct1688 } from '../types';

function buildProduct(overrides: Partial<RawProduct1688> = {}): RawProduct1688 {
  return {
    productId: '1',
    platform: '1688',
    titleCn: '工厂批发 PVC 充气沙发 植绒懒人椅带脚凳',
    titleEn: 'inflatable chair with ottoman',
    description: '',
    priceYuan: 42,
    moq: 1,
    weightKg: 1.8,
    images: [],
    supplierName: '测试供应商',
    supplierType: 'seller',
    mainImageUrl: '',
    normalized1688: {
      pricing: {
        quoteType: 'direct',
        displayPriceYuan: 42,
        rawPriceFields: [],
      },
      moq: 1,
      skuCount: 1,
      skuVariants: [{ name: 'коричневый с насосом', price: 42 }],
      imageCount: 0,
      images: [],
      weightKg: 1.8,
      attributes: [
        { name: '材质', value: 'PVC 植绒' },
        { name: '尺寸', value: '125×92×82 см' },
      ],
      keyAttributes: [],
      debug: {
        quoteType: 'direct',
        rawPriceFields: [],
        skuCount: 1,
        attributesCount: 2,
        imageCount: 0,
        extraInfoKeys: [],
        missingCriticalFields: [],
      },
    },
    ...overrides,
  };
}

describe('buildProductFactSheet', () => {
  it('marks key missing fields and shipping ambiguity for inflatable goods', () => {
    const factSheet = buildProductFactSheet(buildProduct({ selectedSkuName: '' }));
    expect(factSheet.missingRequired).toContain('Выбранный SKU');
    expect(factSheet.conflicts.some((item) => item.key === 'shipping_dimensions_basis')).toBe(true);
  });

  it('creates a high conflict when selected sku is absent from sku list', () => {
    const factSheet = buildProductFactSheet(buildProduct({ selectedSkuName: 'серый без насоса' }));
    expect(factSheet.conflicts.some((item) => item.key === 'selected_sku')).toBe(true);
  });
});
