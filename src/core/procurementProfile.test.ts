import { describe, it, expect } from 'vitest';
import { buildProductProcurementProfile, buildMainReportFromProfile, buildSeoDraftFromProfile, buildBuyerBriefFromProfile, buildSupplierQuestionsFromProfile, buildCargoBriefFromProfile, dedupBulletsByOverlap } from './procurementProfile';

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
    // asserted as fact in the title while the card asks to confirm it. (No \b after
    // the Cyrillic unit — JS \b is ASCII-only and would make this assertion vacuous.)
    expect(nameLine).not.toMatch(/\d+\s*(?:см|мм|кг|мл)/);
    // the object noun survives — we strip the measurement, not the product
    expect(nameLine).toMatch(/нож/);
  });
});

describe('supplier questions — hard gate + cargo essentials', () => {
  const dryer = () =>
    baseProduct({
      titleRu: 'Высокоскоростной фен',
      productKind: 'small_appliance',
      priceYuan: 28,
      weightKg: 0.62,
      skus: [
        { name: 'только кейс', priceYuan: 28 },
        { name: 'кейс и насадка', priceYuan: 28 },
        { name: 'кейс и фен', priceYuan: 28 },
      ],
      productContext: {
        procurementProfileDraft: {
          procurement: {
            mustAskSupplier: [
              'Какова реальная потребляемая мощность в ваттах?',
              'Есть ли сертификаты безопасности (CE, RoHS, EAC)?',
              'Какой тип двигателя используется?',
              'Какова длина сетевого шнура?',
              'Поддерживает ли фен напряжение 220В?',
              'Есть ли защита от перегрева?',
              'Какие режимы температуры доступны?',
              'Есть ли гарантия?',
              'Какой стандарт вилки?',
              'Есть ли ионизация?',
            ],
          },
        },
      },
    });

  it('leads with the SKU-composition question when the variant is unconfirmed', () => {
    const p = buildProductProcurementProfile(dryer());
    expect(p.sku.selectedSkuReliable).toBe(false);
    expect(p.procurement.mustAskSupplier[0].toLowerCase()).toMatch(/какой именно sku|что.*входит в.*комплект/);
    expect(p.procurement.leadQuestions.length).toBeGreaterThan(0);
  });

  it('keeps cargo essentials (packed weight, package dims) despite a long LLM list', () => {
    const j = buildProductProcurementProfile(dryer()).procurement.mustAskSupplier.join(' ').toLowerCase();
    expect(j).toMatch(/вес.*индивидуальн.*упаковк/);
    expect(j).toMatch(/габарит.*индивидуальн.*упаковк/);
  });

  it('does not duplicate the variant question', () => {
    const qs = buildProductProcurementProfile(dryer()).procurement.mustAskSupplier;
    const variantAsks = qs.filter((q) => /вариант\/sku|какой именно sku/i.test(q));
    expect(variantAsks.length).toBe(1);
  });

  it('leads the risks with a hard SKU-composition red flag when unconfirmed', () => {
    const p = buildProductProcurementProfile(dryer());
    expect(p.procurement.redFlags[0].toLowerCase()).toMatch(/не тем комплектом|не только упаковк/);
  });

  it('renders the paired RU+CN version from the persisted list (no CN drop)', () => {
    const ru = ['Какой SKU за 28 ¥?', 'Какова мощность?', 'Есть ли сертификаты?'];
    const cn = ['所选SKU对应28元吗？', '功率是多少？', '有认证吗？'];
    const res = buildSupplierQuestionsFromProfile(
      baseProduct({
        titleRu: 'Фен',
        productKind: 'small_appliance',
        supplierQuestionsRu: ru,
        supplierQuestionsCn: cn,
        supplierQuestionsCnValid: true,
      }),
    );
    expect(res.ru).toEqual(ru);
    expect(res.cnValid).toBe(true);
    expect(res.cn.length).toBe(res.ru.length);
    expect(res.text).not.toMatch(/не сформирована/);
  });
});

describe('SEO draft quality — writer prose is the single source', () => {
  const seoProse = {
    title: 'Кухонный нож цайдао 20 см из нержавеющей стали для нарезки мяса и овощей',
    description:
      'Кухонный нож цайдао для нарезки мяса, овощей и рыбы на домашней кухне. Заявленный материал — нержавеющая сталь, рукоять деревянная.',
    bullets: [
      'Подходит для нарезки овощей, мяса и кухонных работ',
      'Лезвие из нержавеющей стали, рукоять из дерева',
      'Рекомендуется мыть вручную и вытирать насухо',
    ],
    keywords: ['нож цайдао', 'нож кухонный поварской', 'нож для мяса и овощей'],
  };
  const knife = () =>
    baseProduct({
      titleRu: 'Кухонный нож цайдао для мяса',
      productKind: 'knife',
      polishedDocs: { seoProse },
    });

  function section(md: string, header: string): string {
    const lines = md.split('\n');
    const i = lines.findIndex((l) => l.trim() === header);
    return i === -1 ? '' : (lines[i + 1] ?? '');
  }

  it('description is pure customer copy — no seller-facing publish caveats', () => {
    const desc = section(buildSeoDraftFromProfile(knife()), '## Описание').toLowerCase();
    expect(desc.length).toBeGreaterThan(20);
    expect(desc).not.toMatch(/у поставщик|перед публикацией|выбранный sku|реальные фото|неподтверждённые свойства/);
  });

  it('prefers the writer title but strips the unconfirmed measurement', () => {
    const title = section(buildSeoDraftFromProfile(knife()), '## Название').toLowerCase();
    expect(title).toMatch(/нож/);
    expect(title).not.toMatch(/\d+\s*(?:см|мм|кг|мл)/);
  });

  it('prefers the writer keywords', () => {
    const kw = section(buildSeoDraftFromProfile(knife()), '## Ключевые слова').toLowerCase();
    expect(kw).toMatch(/цайдао/);
  });

  it('prefers the writer title when it adds search intent without unsafe claims', () => {
    const product = baseProduct({
      titleRu: 'Кухонный нож для мяса',
      productKind: 'knife',
      polishedDocs: {
        seoProse: {
          ...seoProse,
          title: 'Нож сантоку кухонный для мяса и овощей домашний поварской',
        },
      },
    });
    const title = section(buildSeoDraftFromProfile(product), '## Название').toLowerCase();
    expect(title).toMatch(/сантоку/);
  });

  it('fails closed to the deterministic title when the writer title is structurally broken', () => {
    const product = baseProduct({
      titleRu: 'Фен для волос',
      productKind: 'small_appliance',
      polishedDocs: {
        seoProse: {
          title: 'Фен без — сушка волос после мытья, укладка волос',
          description: 'Фен для сушки волос дома.',
          bullets: [
            'Подходит для сушки волос после мытья',
            'Удобен для домашнего использования',
            'Компактный формат удобно хранить на полке',
          ],
          keywords: ['фен для волос', 'фен домашний'],
          characteristics: [],
        },
      },
    });
    const title = section(buildSeoDraftFromProfile(product), '## Название').toLowerCase();
    expect(title).toMatch(/фен/);
    expect(title).not.toMatch(/без\s+—|сушка волос после/);
  });

  it('drops unconfirmed search claims from title, description and keywords', () => {
    const product = baseProduct({
      titleRu: 'Фен для волос',
      productKind: 'small_appliance',
      polishedDocs: {
        seoProse: {
          title: 'Фен с ионизацией 1450 Вт для салона',
          description:
            'Фен для сушки волос и укладки. Подходит для использования дома или в салоне.',
          bullets: [
            'Сушит волосы после мытья и помогает делать укладку',
            'Подходит для работы в салоне',
            'Удобен для ежедневного применения дома',
          ],
          keywords: [
            'фен для волос',
            'фен 1450 вт',
            'фен для салона',
            'фен с ионизацией',
          ],
          characteristics: [
            { name: 'Ионизация', value: 'есть', status: 'заявлено, уточнить' },
            { name: 'Мощность', value: '1450 Вт', status: 'заявлено, уточнить' },
          ],
        },
      },
    });
    const seo = buildSeoDraftFromProfile(product);
    const title = section(seo, '## Название').toLowerCase();
    const desc = section(seo, '## Описание').toLowerCase();
    const kw = section(seo, '## Ключевые слова').toLowerCase();
    expect(title).not.toMatch(/1450\s*вт|ионизац|салон/);
    expect(desc).not.toMatch(/салон/);
    expect(kw).not.toMatch(/1450\s*вт|салон|ионизац/);
  });

  it('rewrites a bald "материал изделия — X" into declared form', () => {
    const product = baseProduct({
      titleRu: 'Кухонный нож цайдао для мяса',
      productKind: 'knife',
      polishedDocs: {
        seoProse: {
          ...seoProse,
          description:
            'Кухонный нож цайдао для нарезки мяса и овощей. Материал изделия — нержавеющая сталь 3Cr13, рукоять деревянная.',
        },
      },
    });
    const desc = section(buildSeoDraftFromProfile(product), '## Описание').toLowerCase();
    expect(desc).toMatch(/заявленн[а-яё]+ материал/);
    expect(desc).not.toMatch(/материал изделия/);
  });

  it('drops an overloaded laundry-list bullet from polished SEO prose', () => {
    const product = baseProduct({
      titleRu: 'Фен для волос компактный',
      productKind: 'small_appliance',
      polishedDocs: {
        seoProse: {
          title: 'Фен для волос компактный для дома и поездок',
          description:
            'Компактный фен для волос подходит для домашней укладки и хранения в небольшом ящике. Заявленный материал — ABS-пластик.',
          bullets: [
            'По заявлению продавца — высокая скорость потока, ионизация, постоянная температура, бесщёточный мотор, защита от перегрева, точный стандарт вилки и сертификаты; уточните перед заказом',
            'Насадка помогает направить поток воздуха для укладки отдельных прядей',
            'Компактный корпус удобнее хранить на полке или брать с собой',
          ],
          keywords: ['фен для волос', 'фен компактный', 'фен дорожный'],
        },
      },
    });
    const seo = buildSeoDraftFromProfile(product).toLowerCase();
    expect(seo).not.toMatch(/сертификат|ионизац|бесщеточ|постоянн[а-яё]* температур/);
  });
});

describe('dedupBulletsByOverlap — drops near-duplicate bullets', () => {
  it('removes a use-case floor bullet that repeats an LLM use-case bullet', () => {
    const out = dedupBulletsByOverlap([
      'Подходит для нарезки овощей, мяса и кухонных работ',
      'Лезвие из нержавеющей стали, рукоять из дерева',
      'Кухонный нож цайдао — нарезка овощей, нарезка мяса, кухонные работы',
    ]);
    expect(out).toHaveLength(2);
    expect(out.filter((b) => /нарез/i.test(b))).toHaveLength(1);
  });

  it('keeps genuinely distinct bullets', () => {
    const input = [
      'Широкое лезвие удобно шинковать зелень и рубить мясо',
      'Деревянная рукоять с фиксацией на заклёпках',
      'Заявленный материал — нержавеющая сталь',
      'Рекомендуется ручная мойка и просушка',
    ];
    expect(dedupBulletsByOverlap(input)).toHaveLength(4);
  });
});

describe('criticalConfirmations — one domain spine fanned into every surface', () => {
  // A powered device: the LLM emits the electrical block ONCE in
  // domainRules.criticalConfirmations; it must appear in supplier questions, cargo,
  // the buyer brief AND the sample pre-checks — not just one of them.
  const dryer = () =>
    baseProduct({
      titleRu: 'Фен для волос высокоскоростной',
      productContext: {
        procurementProfileDraft: {
          domainRules: {
            criticalConfirmations: [
              'Подтвердите сертификаты CE, RoHS, EAC.',
              'Подтвердите отсутствие аккумулятора в устройстве.',
              'Укажите длину сетевого шнура.',
            ],
          },
        },
      },
    });

  it('lands the spine on the profile and fans it into cargo + pre-sample', () => {
    const p = buildProductProcurementProfile(dryer());
    expect(p.procurement.criticalConfirmations.join(' ')).toMatch(/CE, RoHS, EAC/);
    expect(p.cargo.mustAsk.join(' ')).toMatch(/CE, RoHS, EAC/);
    expect(p.procurement.mustCheckBeforeSample.join(' ')).toMatch(/аккумулятор|шнур/i);
  });

  it('reaches supplier questions and the buyer brief', () => {
    const questions = buildSupplierQuestionsFromProfile(dryer());
    expect(JSON.stringify(questions)).toMatch(/шнур|аккумулятор|CE, RoHS, EAC/i);
    const buyer = buildBuyerBriefFromProfile(dryer());
    expect(buyer).toMatch(/CE, RoHS, EAC|аккумулятор|шнур/i);
  });

  it('prefers assembled supplier questions over a weaker persisted RU/CN pair', () => {
    const product = baseProduct({
      titleRu: 'Фен для волос',
      productKind: 'small_appliance',
      supplierQuestionsRu: [
        'Подтвердите цену выбранного SKU.',
        'Пришлите реальные фото выбранного SKU.',
        'Укажите вес с упаковкой.',
      ],
      supplierQuestionsCn: ['请确认所选SKU价格。', '请提供所选SKU实拍图。', '请提供含包装重量。'],
      supplierQuestionsCnValid: true,
      productContext: {
        procurementProfileDraft: {
          domainRules: {
            criticalConfirmations: [
              'Подтвердите сертификаты CE, RoHS, EAC.',
              'Подтвердите отсутствие аккумулятора в устройстве.',
            ],
          },
        },
      },
    });
    const res = buildSupplierQuestionsFromProfile(product);
    const joined = res.ru.join(' ').toLowerCase();
    expect(joined).toMatch(/аккумулятор/);
    expect(joined).toMatch(/сертификат|ce, rohs, eac/);
  });
});

describe('cargo brief grounding', () => {
  it('renders the deterministic cargo profile instead of reusing a hallucinated polished cargo doc', () => {
    const cargo = buildCargoBriefFromProfile(
      baseProduct({
        titleRu: 'Фен для волос',
        productKind: 'small_appliance',
        polishedDocs: {
          cargo: '# ТЗ карго\n\nКожаный кейс, 1450 Вт, подарочная комплектация.',
        },
        productContext: {
          procurementProfileDraft: {
            domainRules: {
              criticalConfirmations: [
                'Подтвердите сертификаты CE, RoHS, EAC.',
                'Подтвердите отсутствие аккумулятора в устройстве.',
                'Укажите тип вилки и напряжение питания.',
              ],
            },
          },
        },
      }),
    ).toLowerCase();
    expect(cargo).toMatch(/# тз карго/);
    expect(cargo).toMatch(/что нужно запросить для доставки/);
    expect(cargo).not.toMatch(/кожан|1450|подарочн/);
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
