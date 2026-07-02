import { describe, expect, it } from 'vitest';
import {
  buildProductProcurementProfile,
  buildMainReportFromProfile,
  buildSupplierQuestionsFromProfile,
  buildBuyerBriefFromProfile,
  buildSampleChecklistFromProfile,
  buildSeoDraftFromProfile,
  validateDocuments,
} from './procurementProfile';
import { build1688Detail } from './decisionLayer';
import { cleanRawAttributes } from './rawAttributeCleaner';

const dishRackProduct: any = {
  offerId: 'dish-rack-regression',
  titleCn: 'cross-border 厨房置物架碗碟盘多层收纳架碗盘架沥水架家用台面多 储物',
  titleRu: '',
  priceYuan: 20.5,
  moq: 1,
  supplierType: 'factory',
  supplierRating: 4.5,
  sold: 380,
  supplierName: 'нержавеющая сталь',
  attributes: [
    { name: 'type', value: 'для cross-border торговли функции' },
    { name: 'audience', value: 'унисекс' },
    { name: 'gender', value: 'unknown' },
    { name: 'season', value: 'всесезон' },
    { name: 'material', value: ',,' },
    { name: 'stock', value: '69999793' },
    { name: 'Материал', value: 'нержавеющая сталь' },
    { name: 'Размер', value: '43 см / 53 см' },
  ],
  normalized1688: {
    moq: 1,
    supplierType: 'factory',
    images: ['https://example.com/1.jpg'],
    imageCount: 1,
    skuVariants: [
      { name: 'чёрный · 2 яруса · 43 см · полный комплект', price: 20.5 },
      { name: 'чёрный · 3 яруса · 53 см · полный комплект', price: 27.5 },
    ],
    attributes: [],
    pricing: { selectedSkuName: 'чёрный · 2 яруса · 43 см · полный комплект', selectedSkuPriceYuan: 20.5 },
  },
  skus: [
    { name: 'чёрный · 2 яруса · 43 см · полный комплект', price: 20.5 },
    { name: 'чёрный · 3 яруса · 53 см · полный комплект', price: 27.5 },
  ],
  selectedSkuName: 'чёрный · 2 яруса · 43 см · полный комплект',
  selectedSkuPriceYuan: 20.5,
};

describe('CardZip quality regression', () => {
  it('cleans raw attribute pollution', () => {
    const cleaned = cleanRawAttributes(dishRackProduct.attributes);
    const serialized = JSON.stringify(cleaned.userFacing);
    expect(serialized).not.toMatch(/cross-border|для cross-border|audience|gender|season|69999793/);
    expect(JSON.stringify(cleaned.rejectedTitleCandidates)).toMatch(/cross-border/);
  });

  it('builds dish_rack profile and user-facing artifacts without raw pollution', () => {
    const profile = buildProductProcurementProfile(dishRackProduct);
    expect(['dish_rack', 'kitchen_storage_rack']).toContain(profile.identity.productKind);
    expect(profile.identity.titleForSeo).toContain('Сушилка для посуды');
    expect(profile.supplier.name).toBe('не указано');

    const main = buildMainReportFromProfile(dishRackProduct);
    const details = build1688Detail(dishRackProduct);
    const questions = buildSupplierQuestionsFromProfile(dishRackProduct).text;
    const buyer = buildBuyerBriefFromProfile(dishRackProduct);
    const sample = buildSampleChecklistFromProfile(dishRackProduct);
    const seo = buildSeoDraftFromProfile(dishRackProduct);
    const all = [main, details, questions, buyer, sample, seo].join('\n');

    expect(all).not.toMatch(/из карточки 1688|cross-border|для cross-border|тип товара:\s*home|аудитория:|пол:|сезон:|69999793/iu);
    expect(seo).not.toMatch(/^\s*\d+\.\s*товар\s*$/imu);
    expect(questions).toMatch(/количество ярусов|43\/53|поддон|полный комплект|материал.*покрытие/i);
    expect(sample).toMatch(/устойчивость|покрытие|сборк|поддон|острых кромок|деформац/i);

    const validation = validateDocuments([
      { filename: '02_ТЗ_байеру.md', text: buyer },
      { filename: '04_Чеклист_образца.md', text: sample },
      { filename: '05_SEO_черновик.md', text: seo },
    ], profile);
    expect(validation.errors.join('\n')).not.toMatch(/raw pollution|generic checklist|bad SEO/i);
  });
});


describe('legacy_market_text_absent', () => {
  it('does not allow old marketplace/financial terms in procurement result', () => {
    const text = [
      'CardZip — закупочный пакет',
      'SEO-черновик карточки товара',
      'ТЗ байеру',
      'ТЗ карго',
      'Чек-лист образца',
    ].join('\n');
    expect(text).not.toMatch(/\b(?:WB|Ozon|Wildberries|ROI)\b|марж|прибыл|доходност|окупаем/i);
  });
});
