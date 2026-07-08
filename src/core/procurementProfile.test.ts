import { describe, it, expect } from 'vitest';
import { buildProductProcurementProfile, buildMainReportFromProfile, buildSeoDraftFromProfile, buildBuyerBriefFromProfile } from './procurementProfile';

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

// NOTE: Per-category hardcoded KIND_RULES (juicer, tool_kit, small_appliance, …)
// are no longer the architecture. Product-kind behaviour now comes from the
// LLM-produced domainRules (see dynamicDomainRules.test.ts). The tests below only
// cover kinds that still ship a static fallback and generic report invariants that
// must hold regardless of how the kind was resolved.

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
    expect(asks).not.toMatch(/напряжение|тип вилки/);
  });
});

describe('SEO title grounding', () => {
  it('does not assert an unconfirmed material grade code (3Cr13) in the title', () => {
    const product = baseProduct({ titleRu: 'Кухонный нож-топорик сталь 3Cr13 для мяса и овощей' });
    const profile = buildProductProcurementProfile(product);
    expect(profile.identity.titleForSeo.toLowerCase()).not.toMatch(/3\s*cr\s*13/i);

    const seo = buildSeoDraftFromProfile(product).split('\n');
    const nameIdx = seo.findIndex((l) => l.trim() === '## Название');
    const nameLine = (seo[nameIdx + 1] ?? '').toLowerCase();
    expect(nameLine).not.toMatch(/3\s*cr\s*13/i);
    // base material noun and the object survive — we soften the grade, not the noun
    expect(nameLine).toMatch(/нож/);
  });

  it('does not assert an unconfirmed physical measurement (20 см) in the title', () => {
    const product = baseProduct({ titleRu: 'Кухонный нож для нарезки мяса и овощей 20 см' });
    const seo = buildSeoDraftFromProfile(product).split('\n');
    const nameIdx = seo.findIndex((l) => l.trim() === '## Название');
    const nameLine = (seo[nameIdx + 1] ?? '').toLowerCase();
    // On 1688 the dimension is a seller claim, never confirmed → it must not be
    // asserted as fact in the title while the card asks to confirm it.
    expect(nameLine).not.toMatch(/\d+\s*(?:см|мм|кг|мл)\b/);
    // the object noun survives — we strip the measurement, not the product
    expect(nameLine).toMatch(/нож/);
  });
});

describe('SEO bullets drop empty audience filler', () => {
  it('rejects vague marketing bullets that state no concrete fact', () => {
    const product = baseProduct({
      titleRu: 'Кухонный нож-топорик сталь для мяса',
      productContext: {
        procurementProfileDraft: {
          domainRules: {
            seo: {
              sellingBullets: [
                'Подходит как для домашнего использования, так и для тех, кто ценит функциональность',
                'Станет незаменимым помощником на любой кухне',
                'Лезвие из нержавеющей стали для нарезки мяса и овощей',
              ],
            },
          },
        },
      },
    });
    const seo = buildSeoDraftFromProfile(product).toLowerCase();
    expect(seo).not.toMatch(/так и для тех, кто ценит/);
    expect(seo).not.toMatch(/станет незаменимым помощником/);
  });
});

describe('SEO bullets are 3–5 honest, never padded with filler', () => {
  it('does not pad to 5 with hollow marketing filler', () => {
    const seo = buildSeoDraftFromProfile(baseProduct({ titleRu: 'Простой товар без данных' })).split('\n');
    const start = seo.findIndex((l) => l.trim() === '## Буллеты');
    const end = seo.findIndex((l, i) => i > start && l.startsWith('## '));
    const bulletLines = seo.slice(start + 1, end === -1 ? undefined : end).filter((l) => /^\d+\.\s+/.test(l));
    expect(bulletLines.length).toBeGreaterThanOrEqual(1);
    expect(bulletLines.length).toBeLessThanOrEqual(5);
    const joined = bulletLines.join(' ').toLowerCase();
    expect(joined).not.toMatch(/универсальный вариант для дома и в подарок/);
    expect(joined).not.toMatch(/компактный формат — удобно хранить/);
  });
});

describe('buyer brief does not duplicate the supplier questions file', () => {
  it('shows a compact slot checklist and points to 01_Вопросы instead of re-dumping questions', () => {
    const buyer = buildBuyerBriefFromProfile(baseProduct({ titleRu: 'Кухонный нож-топорик сталь для мяса' }));
    expect(buyer).toMatch(/01_Вопросы_поставщику\.txt/);
    const low = buyer.toLowerCase();
    expect(low).toMatch(/точный материал/);
    expect(low).toMatch(/габаритные размеры/);
    expect(low).toMatch(/коробе/);
    // section 1 now exposes weight + package dimensions as card facts
    expect(buyer).toMatch(/Вес:/);
    expect(buyer).toMatch(/Габариты упаковки:/);
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
