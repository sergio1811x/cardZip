import { describe, it, expect } from 'vitest';
import { buildProductProcurementProfile, buildMainReportFromProfile } from './procurementProfile';

function baseProduct(overrides: Record<string, any> = {}) {
  return {
    titleRu: 'Товар 1688',
    titleCn: '产品',
    priceYuan: 50,
    moq: 1,
    weightKg: 0.4,
    supplierType: 'seller',
    ...overrides,
  };
}

describe('productKind: footwear', () => {
  it('asks about size grid and insole, never voltage/plug', () => {
    const profile = buildProductProcurementProfile(baseProduct({ titleRu: 'Сабо обувь EVA', productKind: 'footwear' }));
    expect(profile.identity.productKind).toBe('footwear');
    const asks = profile.procurement.mustAskSupplier.join(' ').toLowerCase();
    expect(asks).toMatch(/размерн|стельк/);
    expect(asks).not.toMatch(/напряжение|тип вилки/);
  });
});

describe('productKind: umbrella', () => {
  it('asks about ribs, canopy and folded length, never insole/plug', () => {
    const profile = buildProductProcurementProfile(baseProduct({ titleRu: 'Зонт складной автоматический', productKind: 'umbrella' }));
    expect(profile.identity.productKind).toBe('umbrella');
    const asks = profile.procurement.mustAskSupplier.join(' ').toLowerCase();
    expect(asks).toMatch(/спиц|куполом|длину зонта/);
    expect(asks).not.toMatch(/стельк|тип вилки/);
  });
});

describe('productKind: sleep_mask', () => {
  it('never asks about shelf life or consistency', () => {
    const profile = buildProductProcurementProfile(baseProduct({ titleRu: 'Маска для сна 3D', productKind: 'sleep_mask' }));
    expect(profile.identity.productKind).toBe('sleep_mask');
    const asks = profile.procurement.mustAskSupplier.join(' ').toLowerCase();
    expect(asks).not.toMatch(/срок годности|консистенц|тип вилки/);
  });
});

describe('productKind: small_appliance / food_warmer / heating_appliance', () => {
  for (const kind of ['small_appliance', 'food_warmer', 'heating_appliance'] as const) {
    it(`${kind} must ask voltage, power, plug type and certificates`, () => {
      const profile = buildProductProcurementProfile(baseProduct({
        titleRu: 'Электроприбор',
        productProcurementProfileDraft: { identity: { productKind: kind } },
      }));
      expect(profile.identity.productKind).toBe(kind);
      const asks = profile.procurement.mustAskSupplier.join(' ').toLowerCase();
      expect(asks).toMatch(/напряжение/);
      expect(asks).toMatch(/мощность/);
      expect(asks).toMatch(/тип вилки/);
      expect(asks).toMatch(/сертификат/);
      const forbidden = profile.content.seoForbiddenClaims.join(' ').toLowerCase();
      expect(forbidden).toMatch(/защита от перегрева|быстрый нагрев/);
    });
  }
});

describe('productKind: generic_product', () => {
  it('has no foreign-category words and asks only baseline questions', () => {
    const profile = buildProductProcurementProfile(baseProduct({ titleRu: 'Неизвестный товар', productKind: 'unknown_thing' }));
    expect(profile.identity.productKind).toBe('generic_product');
    const asks = profile.procurement.mustAskSupplier.join(' ').toLowerCase();
    expect(asks).not.toMatch(/напряжение|размерн|подошв/);
  });
});

describe('productKind: towel_kilt', () => {
  it('never calls it "мужская юбка-полотенце" and asks about fabric/fixation', () => {
    const profile = buildProductProcurementProfile(baseProduct({ titleRu: 'Полотенце-килт мужское', productKind: 'towel_kilt' }));
    expect(profile.identity.productKind).toBe('towel_kilt');
    const asks = profile.procurement.mustAskSupplier.join(' ').toLowerCase();
    expect(asks).toMatch(/состав ткани|фиксир/);
    expect(profile.content.seoForbiddenClaims.join(' ').toLowerCase()).toMatch(/мужская юбка-полотенце/);
    const text = buildMainReportFromProfile(baseProduct({ titleRu: 'Полотенце-килт мужское', productKind: 'towel_kilt' }));
    expect(text.toLowerCase()).not.toMatch(/мужская юбка-полотенце/);
  });
});

describe('productKind: balaclava (clothing override)', () => {
  it('asks about fabric composition, breathing zone and UV protection only as unconfirmed', () => {
    const profile = buildProductProcurementProfile(baseProduct({ titleRu: 'Балаклава для велосипеда UPF50+', productKind: 'clothing' }));
    expect(profile.identity.productKind).toBe('clothing');
    const asks = profile.procurement.mustAskSupplier.join(' ').toLowerCase();
    expect(asks).toMatch(/состав ткани/);
    expect(asks).toMatch(/дыхани/);
    expect(asks).toMatch(/уф-защита/);
    const forbidden = profile.content.seoForbiddenClaims.join(' ').toLowerCase();
    expect(forbidden).toMatch(/upf50\+ без документов/);
    const asksNoElectrical = asks;
    expect(asksNoElectrical).not.toMatch(/напряжение|тип вилки/);
  });
});

describe('plug standard normalization', () => {
  it('maps Korean/EU/US plug markers from raw SKU text to a clean label', () => {
    const profile = buildProductProcurementProfile(baseProduct({
      titleRu: 'Электрочайник',
      productKind: 'small_appliance',
      skus: [
        { name: '韩规 白色', priceYuan: 50 },
        { name: '欧规 白色', priceYuan: 50 },
      ],
    }));
    expect(profile.sku.plugStandards).toContain('стандарт питания/вилка: Корея');
    expect(profile.sku.plugStandards).toContain('стандарт питания/вилка: EU');
  });
});

describe('main report formatting', () => {
  it('never renders "Цена: Выбранный SKU" or duplicate selected SKU lines', () => {
    const text = buildMainReportFromProfile(baseProduct({ titleRu: 'Товар с SKU', skus: [{ name: 'белый', priceYuan: 50 }, { name: 'чёрный', priceYuan: 55 }] }));
    expect(text).not.toMatch(/Цена:\s*Выбранный SKU/);
    expect((text.match(/Выбранный SKU:/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it('shows at most 3 materials', () => {
    const text = buildMainReportFromProfile(baseProduct({
      titleRu: 'Товар с материалами',
      productContext: { productIntelligence: { productIdentity: { materials: ['хлопок', 'полиэстер', 'эластан', 'вискоза', 'нейлон'] } } },
    }));
    const materialLine = text.split('\n').find(l => l.includes('Материал:')) ?? '';
    const count = materialLine.replace('• Материал:', '').split(',').filter(s => s.trim() && !/подтвердить/i.test(s)).length;
    expect(count).toBeLessThanOrEqual(3);
  });
});
