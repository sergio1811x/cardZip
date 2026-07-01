import { describe, it, expect } from 'vitest';
import { buildProductProcurementProfile, buildMainReportFromProfile, buildBuyerBriefFromProfile, buildSeoDraftFromProfile, buildSupplierQuestionsFromProfile } from './procurementProfile';

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

describe('productKind: tool_kit', () => {
  function toolKitProduct() {
    return baseProduct({
      titleRu: 'Набор инструментов для дома',
      priceYuan: 148,
      productKind: 'tool_kit',
      selectedSkuName: '8102',
      skus: [
        { name: '26', priceYuan: 148 },
        { name: '35', priceYuan: 148 },
        { name: '102', priceYuan: 148 },
        { name: '120', priceYuan: 148 },
        { name: '8102', priceYuan: 148 },
      ],
      attributes: [{ name: '材质', value: '高品质碳钢' }],
    });
  }

  it('never mixes price with the selected SKU line and shows both separately', () => {
    const text = buildMainReportFromProfile(toolKitProduct());
    expect(text).not.toMatch(/Цена:\s*Выбранный SKU/);
    expect(text).toMatch(/Цена: 148 ¥ ≈ [\d\s]+₽/);
    expect(text).toMatch(/Выбранный SKU: набор 8102 — состав нужно подтвердить/);
  });

  it('describes ambiguous SKU numbers as комплектация/модель, not as a generic parameter', () => {
    const profile = buildProductProcurementProfile(toolKitProduct());
    expect(profile.sku.skuSummary).toMatch(/комплектация\/модель/);
    expect(profile.sku.skuWarnings.join(' ')).toMatch(/уточнить точный состав/);
  });

  it('dedups and normalizes material to a single line asking to confirm steel grade and handles', () => {
    const text = buildBuyerBriefFromProfile(toolKitProduct());
    expect(text).toMatch(/Материал: .+— подтвердить марку стали и материал ручек/);
    expect((text.match(/Материал:/g) ?? []).length).toBe(1);
  });

  it('always asks weight with packaging, composition of the selected SKU, and photos of the open case', () => {
    const q = buildSupplierQuestionsFromProfile(toolKitProduct());
    expect(q.ru.length).toBeLessThanOrEqual(10);
    const joined = q.ru.join(' ').toLowerCase();
    expect(joined).toMatch(/вес набора с индивидуальной упаковкой/);
    expect(joined).toMatch(/количество предметов в наборе/);
    expect(joined).toMatch(/фото раскрытого кейса/);
    expect(q.ru.every(line => !/\bвес\b/i.test(line) || /с упаковкой/i.test(line))).toBe(true);
  });

  it('buyer brief never falls back to generic electrical-appliance checks', () => {
    const text = buildBuyerBriefFromProfile(toolKitProduct());
    expect(text.toLowerCase()).not.toMatch(/напряжение|тип вилки|защита от перегрева|электроинструмент/);
  });

  it('SEO has no internal boilerplate phrase and exactly 5 bullets', () => {
    const text = buildSeoDraftFromProfile(toolKitProduct());
    expect(text).not.toMatch(/черновик карточки на основе данных 1688/i);
    const bulletSection = text.match(/## Буллеты\n([\s\S]*?)(?:\n## |$)/)?.[1] ?? '';
    expect(bulletSection.match(/^\d+\.\s+/gm)?.length).toBe(5);
    const forbidden = text.match(/## Нельзя писать как факт\n([\s\S]*?)(?:\n## |$)/)?.[1] ?? '';
    expect(forbidden.toLowerCase()).toMatch(/профессиональный/);
    expect(forbidden.toLowerCase()).toMatch(/закалённая сталь/);
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
