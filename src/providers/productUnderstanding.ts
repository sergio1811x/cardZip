// ─── Types ────────────────────────────────────────────────────────────────────

export type KitType = 'body_only' | 'basic_kit' | 'full_kit' | 'unknown';

export interface ProductStructure {
  canonicalNameRu: string;
  productFamily: string;
  productType: string;
  coreObject: string;
  audience: string;
  useCase: string[];
  material: string[];
  formFactor: string[];
  powerType: string[];
  size: string[];
  volume: string[];
  color: string[];
  compatibility: string[];
  includedItems: string[];
  requiredAttributes: string[];
  importantAttributes: string[];
  optionalAttributes: string[];
  subType: string;
  lengthClass: string;
  shapeType: string;
  closureType: string;
  visualStyle: string[];
  hardFormConflicts: string[];
  softFormConflicts: string[];
  mustKeep: string[];
  canDrop: string[];
  doNotSearch: string[];
  marketSynonyms: string[];
  directAnalogBlockers: string[];
  hardConflicts: string[];
  softConflicts: string[];
  compatibleAlternatives: string[];
  categoryHypotheses: string[];
  searchIntent: string;
  kitType: KitType;
  kitContents: string[];
  confidence: number;
}

export interface ProductLexicon {
  mainTerms: string[];
  alternateNames: string[];
  marketNames: string[];
  buyerSearchTerms: string[];
  attributeTerms: string[];
  materialAliases: string[];
  hardNegativeTerms: string[];
  softNegativeTerms: string[];
  broadCategoryTerms: string[];
}

export interface QueryPlan {
  L1_exact: string[];
  L2_commercial: string[];
  L3_subtype: string[];
  L4_core: string[];
  L5_category: string[];
}

export interface FullProductAnalysis {
  structure: ProductStructure;
  lexicon: ProductLexicon;
  queryPlan: QueryPlan;
  validatedQueries: string[];
  wbCoreQuery: string;
  categoryType: string;
  intelligence: import('../types').ProductIntelligence | null;
}

// ─── LLM Call with Fallback ──────────────────────────────────────────────────

const SEARCH_MODELS = [
  'google/gemini-2.5-flash-lite-preview-09-2025',
  'deepseek/deepseek-v4-flash',
  'meta-llama/llama-4-scout',
];

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

async function callLlm(prompt: string, systemMsg: string): Promise<any> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  for (const model of SEARCH_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: 2400, temperature: 0.2,
          messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(cleanJson(raw));
      if (parsed) return parsed;
    } catch { continue; }
  }

  // Fireworks fallback
  const fwKey = process.env.FIREWORKS_API_KEY;
  if (fwKey) {
    try {
      const res = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${fwKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'accounts/fireworks/models/deepseek-v4-flash',
          max_tokens: 2400, temperature: 0.2,
          messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        return JSON.parse(cleanJson(data.choices?.[0]?.message?.content ?? ''));
      }
    } catch {}
  }
  return null;
}

// ─── Combined: Understand + Lexicon + Queries ────────────────────────────────

export async function analyzeProduct(raw: {
  titleCn: string;
  titleEn?: string;
  categoryName?: string;
  attributes?: Array<{ name: string; value: string }>;
  description?: string;
  skus?: Array<{ name: string; price?: number }>;
}): Promise<FullProductAnalysis | null> {
  let info = `Название (CN): ${raw.titleCn}`;
  if (raw.titleEn) info += `\nНазвание (EN): ${raw.titleEn}`;
  if (raw.categoryName) info += `\nКатегория: ${raw.categoryName}`;
  if (raw.attributes?.length) {
    info += '\nХарактеристики:';
    raw.attributes.slice(0, 20).forEach(a => { info += `\n  ${a.name}: ${a.value}`; });
  }
  if (raw.description) info += `\nОписание: ${raw.description.slice(0, 300)}`;
  if (raw.skus?.length) {
    info += '\nSKU:';
    raw.skus.slice(0, 8).forEach(s => { info += `\n  ${s.name} — ${s.price ?? '?'} ¥`; });
  }

  const prompt = `Ты анализируешь товар с 1688 для продажи на карточка товара.

Твоя задача:
1. Понять, что это за товар.
2. Определить категорию товара.
3. Дать короткое закупочное название на русском.
4. Подготовить структуру для поиска похожих товаров на карточка товара.

Верни строго JSON без markdown:

{
  "categoryType": "shoes|clothes|electronics|home|beauty|accessory|kitchen|other",
  "structure": {
    "canonicalNameRu": "нормальное русское название",
    "productFamily": "широкая категория (аксессуары, электроника, одежда, ...)",
    "productType": "конкретный тип (мужской кошелек, настольный вентилятор, ...)",
    "coreObject": "базовый объект (кошелек, вентилятор, зонт, ...)",
    "audience": "целевая аудитория (мужской, женский, детский, унисекс, ...)",
    "useCase": ["сценарии применения"],
    "material": ["материалы и синонимы материалов"],
    "formFactor": ["форм-факторы"],
    "powerType": ["тип питания если применимо"],
    "size": [], "volume": [], "color": [], "compatibility": [],
    "includedItems": ["что в комплекте"],
    "requiredAttributes": ["обязательные признаки для прямого похожий товара"],
    "importantAttributes": ["важные но не обязательные"],
    "optionalAttributes": ["второстепенные"],
    "subType": "узкий подтип (короткий складной кошелек, настольный USB вентилятор, ...)",
    "lengthClass": "short|long|compact|full_size|unknown",
    "shapeType": "форма (bifold, trifold, long_wallet, clutch, cardholder, ...)",
    "closureType": "тип застёжки (button, zipper, magnet, none, unknown)",
    "visualStyle": ["визуальный стиль (мультяшное тиснение, минимализм, ...)"],
    "hardFormConflicts": ["жёсткие конфликты по подтипу/форме (женский клатч, сумка, ...)"],
    "softFormConflicts": ["мягкие конфликты подтипа (длинное портмоне, кошелек для документов, органайзер, travel wallet, кошелек с ремешком, ...)"],
    "hardConflicts": ["если найдено → товар точно НЕ похожий товар"],
    "softConflicts": ["похожие но другие товары"],
    "compatibleAlternatives": ["допустимые похожие варианты (портмоне мужское, бумажник мужской, ...)"],
    "categoryHypotheses": ["гипотезы карточка товара-категорий"],
    "searchIntent": "что ищет покупатель на карточка товара",
    "mustKeep": ["признаки, которые НЕЛЬЗЯ убирать из поиска"],
    "canDrop": ["признаки, которые МОЖНО убрать если поиск слишком узкий (артикул, модель, редкий цвет, ...)"],
    "doNotSearch": ["слова, которые НЕ НАДО использовать в карточка товара-запросах (артикулы, модели, маркетинг, китайские фразы)"],
    "marketSynonyms": ["как товар может называться на карточка товара"],
    "directAnalogBlockers": ["что запрещает считать товар прямым похожим товаром"],
    "kitType": "body_only|basic_kit|full_kit|unknown",
    "kitContents": [],
    "confidence": 0.0-1.0
  },
  "lexicon": {
    "mainTerms": ["основные термины товара"],
    "alternateNames": ["синонимы (портмоне, бумажник, ...)"],
    "marketNames": ["как товар называется на рынке карточка товара"],
    "buyerSearchTerms": ["как покупатели ищут на карточка товара"],
    "attributeTerms": ["ключевые атрибуты"],
    "materialAliases": ["все варианты написания материала"],
    "hardNegativeTerms": ["слова-маркеры нерелевантных товаров"],
    "softNegativeTerms": ["маркеры похожих но не похожие товарычных"],
    "broadCategoryTerms": ["широкие категорийные термины"]
  },
  "wbCoreQuery": "закупочный запрос карточка товара 1-3 слова, конкретный подтип, не широкий",
  "queryLadder": {
    "L1_exact": ["точные запросы: productType + ключевые атрибуты, 2-4 слова"],
    "L2_commercial": ["запросы языком покупателя карточка товара, как ищет обычный человек"],
    "L3_subtype": ["запросы по подтипу/формату товара"],
    "L4_core": ["запросы по базовому объекту + широкий признак"],
    "L5_category": ["самые широкие категорийные запросы, 1-2 слова"]
  }
}

Правила:
- categoryType выбирай только из списка.
- wbCoreQuery: 1-3 слова, как товар реально ищут на карточка товара.
- Китайские термины переводи на русский смысл.

Для обуви (categoryType=shoes):
- Запрещены темы в SEO и отчётах: мощность, напряжение, аккумулятор, тип вилки, рукав, плотность ткани, усадка.
- wbCoreQuery примеры: "сабо мужские", "тапочки домашние зимние", "кроссовки женские".

Для одежды (categoryType=clothes):
- Запрещены: мощность, напряжение, аккумулятор, тип вилки, длина стельки.

Для техники (categoryType=electronics):
- Запрещены: размерная сетка, длина стельки, рукав, плотность ткани, усадка.

Для кухни (categoryType=kitchen):
- Запрещены: размерная сетка, длина стельки, рукав, тип талии.

ПРАВИЛА ЗАПРОСОВ:
- Только русский, 2-4 слова.
- НЕ использовать: "новинка", "опт", "хит", "premium", артикулы, модели, маркетинг, китайский, английский.
- НЕ использовать слова из doNotSearch.
- L1: 2-3 точных запроса.
- L2: 2-3 запроса как ищет покупатель.
- L3: 1-2 запроса по подтипу.
- L4: 1-2 запроса по coreObject.
- L5: 1 широкий категорийный запрос.

ДАННЫЕ:
${info}`;

  try {
    const result = await callLlm(prompt, 'Ты аналитик товаров из Китая. Строишь понимание товара + лексику + запросы. ТОЛЬКО JSON.');
    if (!result?.structure?.coreObject) return null;

    const s = result.structure;
    const structure: ProductStructure = {
      canonicalNameRu: s.canonicalNameRu ?? '',
      productFamily: s.productFamily ?? '',
      productType: s.productType ?? '',
      coreObject: s.coreObject ?? '',
      audience: s.audience ?? '',
      useCase: s.useCase ?? [],
      material: s.material ?? [],
      formFactor: s.formFactor ?? [],
      powerType: s.powerType ?? [],
      size: s.size ?? [],
      volume: s.volume ?? [],
      color: s.color ?? [],
      compatibility: s.compatibility ?? [],
      includedItems: s.includedItems ?? [],
      requiredAttributes: s.requiredAttributes ?? [],
      importantAttributes: s.importantAttributes ?? [],
      optionalAttributes: s.optionalAttributes ?? [],
      subType: s.subType ?? '',
      lengthClass: s.lengthClass ?? 'unknown',
      shapeType: s.shapeType ?? 'unknown',
      closureType: s.closureType ?? 'unknown',
      visualStyle: s.visualStyle ?? [],
      hardFormConflicts: s.hardFormConflicts ?? [],
      softFormConflicts: s.softFormConflicts ?? [],
      hardConflicts: s.hardConflicts ?? [],
      softConflicts: s.softConflicts ?? [],
      compatibleAlternatives: s.compatibleAlternatives ?? [],
      categoryHypotheses: s.categoryHypotheses ?? [],
      searchIntent: s.searchIntent ?? '',
      mustKeep: s.mustKeep ?? [],
      canDrop: s.canDrop ?? [],
      doNotSearch: s.doNotSearch ?? [],
      marketSynonyms: s.marketSynonyms ?? [],
      directAnalogBlockers: s.directAnalogBlockers ?? [],
      kitType: s.kitType ?? 'unknown',
      kitContents: s.kitContents ?? [],
      confidence: s.confidence ?? 0.5,
    };

    const l = result.lexicon ?? {};
    const lexicon: ProductLexicon = {
      mainTerms: l.mainTerms ?? [structure.coreObject],
      alternateNames: l.alternateNames ?? [],
      marketNames: l.marketNames ?? [],
      buyerSearchTerms: l.buyerSearchTerms ?? [],
      attributeTerms: l.attributeTerms ?? [],
      materialAliases: l.materialAliases ?? [],
      hardNegativeTerms: l.hardNegativeTerms ?? [],
      softNegativeTerms: l.softNegativeTerms ?? [],
      broadCategoryTerms: l.broadCategoryTerms ?? [],
    };

    const q = result.queryLadder ?? result.queryPlan ?? {};
    const queryPlan: QueryPlan = {
      L1_exact: q.L1_exact ?? q.exactQueries ?? [],
      L2_commercial: q.L2_commercial ?? q.synonymQueries ?? [],
      L3_subtype: q.L3_subtype ?? q.attributeQueries ?? [],
      L4_core: q.L4_core ?? q.broadQueries ?? [],
      L5_category: q.L5_category ?? q.fallbackQueries ?? [],
    };

    const allQueries = [
      ...queryPlan.L1_exact,
      ...queryPlan.L2_commercial,
      ...queryPlan.L3_subtype,
      ...queryPlan.L4_core,
    ];
    const validatedQueries = validateQueries(allQueries);

    const wbCoreQuery = (result.wbCoreQuery ?? structure.coreObject ?? '').trim();
    const categoryType = result.categoryType ?? 'other';

    return { structure, lexicon, queryPlan, validatedQueries, wbCoreQuery, categoryType, intelligence: null };
  } catch (e) {
    console.error('[analyzeProduct]', e instanceof Error ? e.message : e);
    return null;
  }
}

// ─── Product Intelligence ───────────────────────────────────────────────────

const VISION_MODELS = [
  'google/gemini-2.5-flash-lite-preview-09-2025',
  'google/gemini-2.0-flash-001',
];

async function callLlmWithVision(prompt: string, systemMsg: string, imageBase64: string): Promise<any> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  for (const model of VISION_MODELS) {
    try {
      const messages = [
        { role: 'system', content: systemMsg },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          ],
        },
      ];

      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: 3000, temperature: 0.2,
          messages,
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(cleanJson(raw));
      if (parsed) return parsed;
    } catch { continue; }
  }

  return null;
}

const INTELLIGENCE_PROMPT = `CardZip Product Intelligence.

Роль: закупщик 1688. Нужно точно определить товар и собрать единый профиль для закупочного пакета: отчёт, SKU, вопросы поставщику, ТЗ байеру/карго, чек-лист образца и SEO.

Фото используй только для визуально очевидного: тип товара, форма, конструкция, видимые детали. Цену, MOQ, вес, SKU, размеры и документы бери только из переданных данных, не с фото.

Верни строго JSON без markdown:
{
  "productIdentity": {
    "productKind": "свободный domainKind, например dish_rack, umbrella, clothing, kitchen_scale",
    "categoryType": "shoes|clothes|electronics|home|beauty|accessory|kitchen|other",
    "subCategoryType": "подкатегория",
    "marketNameRu": "понятное закупочное название без raw-мусора",
    "shortNameRu": "2-4 слова",
    "titleForReport": "3-6 слов",
    "titleForSeo": "название карточки товара без неподтверждённых claims",
    "coreObject": "базовый объект",
    "formFactor": "форма/конструкция",
    "audience": "мужской|женский|детский|унисекс|не ясно",
    "ageGroup": "взрослый|детский|все|не ясно",
    "gender": "мужской|женский|унисекс|не ясно",
    "season": "лето|зима|демисезон|всесезон|не применимо",
    "useCases": ["сценарии применения"],
    "materials": ["материалы только из данных"],
    "visibleFeatures": ["только то, что видно на фото"],
    "claimedFeatures": ["заявлено, но требует подтверждения"],
    "unconfirmedFeatures": ["что нельзя писать как факт"],
    "possibleConfusions": ["с чем можно перепутать"]
  },
  "procurement": {
    "status": "нужны данные поставщика|можно запрашивать образец|готов к заказу образца|данных мало",
    "verdict": "короткий вывод под конкретный товар",
    "nextAction": "что сделать сейчас",
    "mustAskSupplier": ["5-10 конкретных вопросов"],
    "mustCheckBeforeSample": ["что проверить до образца"],
    "mustCheckOnSample": ["что проверить на образце"],
    "redFlags": ["риски"]
  },
  "cargo": {"mustAsk": ["что запросить для доставки"], "likelySensitiveCargoIssues": ["ограничения перевозки или нет"]},
  "content": {"seoAllowedClaims": ["что можно писать безопасно"], "seoForbiddenClaims": ["что нельзя писать без подтверждения"], "infographicIdeas": ["идеи слайдов"]},
  "dataQuality": {"missingCriticalFields": [], "contradictions": [], "overallConfidence": "high|medium|low", "visionConfidence": "high|medium|low|none", "textConfidence": "high|medium|low", "reason": "почему"}
}

Правила:
- Не возвращай китайский в русских полях.
- Не копируй raw атрибуты как title; запрещены cross-border, товар, функции, category labels, single number.
- Не придумывай материал, размер, вес, документы, сертификаты, аудиторию или свойства.
- Supplier name не должен браться из material.
- Если свойство заявлено, но не подтверждено — клади в claimedFeatures/unconfirmedFeatures.
- Вопросы должны быть под конкретный productKind, без чужих категорий, максимум 10.
- Для кухонной сушилки/стеллажа спрашивай ярусы, размеры 43/53, материал/покрытие, поддон, комплектацию, устойчивость, упаковку.
- SEO должен быть продающим, но безопасным: dangerous claims только в seoForbiddenClaims.
`;

export async function generateProductIntelligence(raw: {
  titleCn: string;
  titleRu?: string;
  titleEn?: string;
  categoryName?: string;
  attributes?: Array<{ name: string; value: string }>;
  skus?: Array<{ name: string; price?: number }>;
  price?: number;
  mainImageUrl?: string;
}): Promise<import('../types').ProductIntelligence | null> {
  let info = `Товар с 1688:\nНазвание CN: ${raw.titleCn}`;
  if (raw.titleRu) info += `\nНазвание RU: ${raw.titleRu}`;
  if (raw.titleEn) info += `\nНазвание EN: ${raw.titleEn}`;
  if (raw.categoryName) info += `\nКатегория 1688: ${raw.categoryName}`;
  if (raw.price) info += `\nЦена: ${raw.price} ¥`;
  if (raw.attributes?.length) {
    info += '\nАтрибуты поставщика:';
    raw.attributes.slice(0, 20).forEach(a => { info += `\n  ${a.name}: ${a.value}`; });
  }
  if (raw.skus?.length) {
    info += `\nSKU/варианты (${raw.skus.length}):`;
    raw.skus.slice(0, 8).forEach(s => { info += `\n  ${s.name} — ${s.price ?? '?'} ¥`; });
  }

  // Download and compress image for vision
  let imageBase64: string | null = null;
  if (raw.mainImageUrl) {
    try {
      const imgRes = await fetch(raw.mainImageUrl, { signal: AbortSignal.timeout(5000) });
      if (imgRes.ok) {
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        // Limit to 500KB
        if (buffer.length < 500_000) {
          imageBase64 = buffer.toString('base64');
        } else {
          console.log('[intelligence] Image too large, skipping vision');
        }
      }
    } catch (e) {
      console.log('[intelligence] Image download failed:', (e as Error).message);
    }
  }

  const prompt = `${INTELLIGENCE_PROMPT}\n\nДанные товара:\n${info}`;
  const systemMsg = 'Ты — товарный аналитик для карточка товара. Анализируешь товары с 1688. Верни СТРОГО JSON.';

  try {
    let result: any = null;
    if (imageBase64) {
      result = await callLlmWithVision(prompt, systemMsg, imageBase64);
    }
    // Fallback to text-only
    if (!result) {
      result = await callLlm(prompt, systemMsg);
    }
    if (!result?.productIdentity?.marketNameRu) return null;

    return {
      productIdentity: {
        marketNameRu: result.productIdentity.marketNameRu ?? '',
        shortNameRu: result.productIdentity.shortNameRu ?? '',
        productKind: result.productIdentity.productKind ?? '',
        categoryPath: result.productIdentity.categoryPath ?? [],
        categoryType: result.productIdentity.categoryType ?? '',
        subCategoryType: result.productIdentity.subCategoryType ?? '',
        audience: result.productIdentity.audience ?? '',
        useCases: result.productIdentity.useCases ?? [],
        coreObject: result.productIdentity.coreObject ?? '',
        formFactor: result.productIdentity.formFactor ?? '',
        material: result.productIdentity.material ?? [],
        powerType: result.productIdentity.powerType ?? [],
        season: result.productIdentity.season ?? '',
        gender: result.productIdentity.gender ?? '',
        ageGroup: result.productIdentity.ageGroup ?? '',
        importantFeatures: result.productIdentity.importantFeatures ?? [],
        notConfirmedFeatures: result.productIdentity.notConfirmedFeatures ?? [],
        visibleFeatures: result.productIdentity.visibleFeatures ?? [],
        possibleConfusions: result.productIdentity.possibleConfusions ?? [],
      },
      cleanTitles: {
        titleCnClean: result.cleanTitles?.titleCnClean ?? '',
        titleRuClean: result.cleanTitles?.titleRuClean ?? '',
        titleForReport: result.cleanTitles?.titleForReport ?? '',
        titleForWb: result.cleanTitles?.titleForWb ?? '',
      },
      wbSearch: {
        wbCoreQuery: result.wbSearch?.wbCoreQuery ?? '',
        queryCandidates: result.wbSearch?.queryCandidates ?? [],
        negativeSearchTerms: result.wbSearch?.negativeSearchTerms ?? [],
        tooBroadQueries: result.wbSearch?.tooBroadQueries ?? [],
        tooNarrowQueries: result.wbSearch?.tooNarrowQueries ?? [],
      },
      matchingRules: {
        mustHaveForDirectAnalog: result.matchingRules?.mustHaveForDirectAnalog ?? [],
        allowedDifferences: result.matchingRules?.allowedDifferences ?? [],
        directAnalogBlockers: result.matchingRules?.directAnalogBlockers ?? [],
        similarOnlyIf: result.matchingRules?.similarOnlyIf ?? [],
        rejectIf: result.matchingRules?.rejectIf ?? [],
      },
      reportRules: {
        buyerMustCheck: result.reportRules?.buyerMustCheck ?? [],
        buyerMustNotAsk: result.reportRules?.buyerMustNotAsk ?? [],
        seoAllowedClaims: result.reportRules?.seoAllowedClaims ?? [],
        seoForbiddenClaims: result.reportRules?.seoForbiddenClaims ?? [],
        importantAttributesToShow: result.reportRules?.importantAttributesToShow ?? [],
        attributesToHide: result.reportRules?.attributesToHide ?? [],
        riskFlags: result.reportRules?.riskFlags ?? [],
      },
      supplierQuestions: {
        ru: result.supplierQuestions?.ru ?? [],
        cn: result.supplierQuestions?.cn ?? [],
      },
      dataQuality: {
        missingCriticalFields: result.dataQuality?.missingCriticalFields ?? [],
        skuRisk: result.dataQuality?.skuRisk ?? '',
        priceRisk: result.dataQuality?.priceRisk ?? '',
        weightRisk: result.dataQuality?.weightRisk ?? '',
        overallConfidence: result.dataQuality?.overallConfidence ?? result.dataQuality?.confidence ?? 'low',
        visionConfidence: result.dataQuality?.visionConfidence ?? 'none',
        textConfidence: result.dataQuality?.textConfidence ?? 'low',
        reason: result.dataQuality?.reason ?? '',
      },
    };
  } catch (e) {
    console.error('[intelligence]', e instanceof Error ? e.message : e);
    return null;
  }
}

// ─── Adaptive Query Expansion (after PASS 1) ─────────────────────────────────

export async function expandQueries(
  structure: ProductStructure,
  frequentTokens: string[],
  frequentBigrams: string[]
): Promise<string[]> {
  const prompt = `На основе товара и частотных слов из карточка товара сгенерируй 5-10 ДОПОЛНИТЕЛЬНЫХ русских запросов.

ТОВАР: ${structure.productType} (${structure.coreObject})
Аудитория: ${structure.audience}

Частотные слова карточка товара: ${frequentTokens.slice(0, 15).join(', ')}
Частотные биграммы карточка товара: ${frequentBigrams.slice(0, 10).join(', ')}

Сгенерируй запросы которых НЕ было в первом поиске. Используй реальные карточка товара-термины.
Только русский, 2-4 слова. JSON: {"queries": ["запрос1", "запрос2"]}`;

  try {
    const result = await callLlm(prompt, 'Генератор карточка товара-запросов. ТОЛЬКО JSON.');
    return validateQueries(
      (result?.queries ?? []).map((q: string) => ({ query: q, purpose: 'adaptive', priority: 2 }))
    );
  } catch { return []; }
}

// ─── LLM Judge (for top-N candidates) ────────────────────────────────────────

export type MatchLevel = 'direct_analog' | 'similar' | 'category_only' | 'wrong';

export interface JudgeResult {
  matchLevel: MatchLevel;
  confidence: number;
  matchedAttributes: string[];
  missingAttributes: string[];
  blockingConflicts: string[];
  reason: string;
}

export async function judgeCandidate(
  source: ProductStructure,
  candidate: { title: string; category?: string; brand?: string; price: number; detectedConflicts: string[] }
): Promise<JudgeResult | null> {
  const prompt = `Оцени, является ли карточка товара похожим товаром товара.

ТОВАР:
Тип: ${source.productType}
Объект: ${source.coreObject}
Аудитория: ${source.audience}
Обязательные: ${source.requiredAttributes.join(', ')}
Важные: ${source.importantAttributes.join(', ')}
Жёсткие конфликты: ${source.hardConflicts.join(', ')}
Мягкие конфликты: ${source.softConflicts.join(', ')}
Допустимые альтернативы: ${source.compatibleAlternatives.join(', ')}

карточка товара-КАРТОЧКА:
${candidate.title}
${candidate.category ? 'Категория: ' + candidate.category : ''}
${candidate.brand ? 'Бренд: ' + candidate.brand : ''}
Цена: ${candidate.price} ₽
Конфликты: ${candidate.detectedConflicts.join(', ') || 'нет'}

ПРАВИЛА:
- Если сомнение между direct_analog и similar → выбери similar.
- Если сомнение между similar и category_only → выбери category_only.
- Если hard conflict → wrong.
- Не считай direct_analog из-за одного общего слова.

JSON: {"matchLevel": "direct_analog|similar|category_only|wrong", "confidence": 0.0-1.0, "matchedAttributes": [], "missingAttributes": [], "blockingConflicts": [], "reason": ""}`;

  try {
    const result = await callLlm(prompt, 'Ты судья продуктового матчинга. Строго. ТОЛЬКО JSON.');
    if (!result?.matchLevel) return null;
    return {
      matchLevel: result.matchLevel,
      confidence: result.confidence ?? 0.5,
      matchedAttributes: result.matchedAttributes ?? [],
      missingAttributes: result.missingAttributes ?? [],
      blockingConflicts: result.blockingConflicts ?? [],
      reason: result.reason ?? '',
    };
  } catch { return null; }
}

// ─── LLM Judge Batch (1 вызов на все кандидаты) ──────────────────────────────

export async function judgeCandidateBatch(
  source: ProductStructure,
  candidates: Array<{ title: string; price: number; detectedConflicts: string[] }>
): Promise<JudgeResult[]> {
  const list = candidates.map((c, i) =>
    `${i + 1}. "${c.title}" (${c.price}₽)${c.detectedConflicts.length ? ' [конфликты: ' + c.detectedConflicts.join(', ') + ']' : ''}`
  ).join('\n');

  const prompt = `Оцени ${candidates.length} карточка товара-карточек — являются ли они похожий товарами товара.

ТОВАР:
Тип: ${source.productType}
Объект: ${source.coreObject}
Аудитория: ${source.audience}
Обязательные: ${source.requiredAttributes.join(', ')}
Жёсткие конфликты: ${source.hardConflicts.join(', ')}
Мягкие конфликты: ${source.softConflicts.join(', ')}

КАНДИДАТЫ:
${list}

ПРАВИЛА:
- Сомнение → similar (не direct_analog)
- Hard conflict → wrong
- Одно общее слово ≠ direct_analog

Верни JSON массив (по порядку кандидатов):
[{"matchLevel": "direct_analog|similar|category_only|wrong", "matchedAttributes": [], "missingAttributes": [], "reason": ""}]`;

  try {
    const result = await callLlm(prompt, 'Ты судья продуктового матчинга. Строго. ТОЛЬКО JSON массив.');
    if (Array.isArray(result)) return result;
    if (result?.results) return result.results;
    return [];
  } catch { return []; }
}

// ─── Search Repair Agent ─────────────────────────────────────────────────────

export async function repairSearch(
  structure: ProductStructure,
  queriesTried: string[],
  topFoundTitles: string[],
  topRejectedTitles: string[],
  mining: { tokens: string[]; bigrams: string[] }
): Promise<{ newQueries: string[]; reason: string }> {
  const prompt = `Ты Search Repair Agent. Поиск карточка товара не нашёл достаточно прямых похожих товаров.

ТОВАР: ${structure.productType} (${structure.coreObject})
Подтип: ${structure.subType || 'нет'}
mustKeep: ${structure.mustKeep?.join(', ') || 'нет'}
canDrop: ${structure.canDrop?.join(', ') || 'нет'}
doNotSearch: ${structure.doNotSearch?.join(', ') || 'нет'}
marketSynonyms: ${structure.marketSynonyms?.join(', ') || 'нет'}

Попробованные запросы: ${queriesTried.join(' | ')}

Топ найденных карточек: ${topFoundTitles.slice(0, 8).join(' | ')}
Топ отклонённых карточек: ${topRejectedTitles.slice(0, 5).join(' | ')}

Частотные слова карточка товара: ${mining.tokens.slice(0, 10).join(', ')}
Частотные биграммы карточка товара: ${mining.bigrams.slice(0, 5).join(', ')}

Проанализируй почему не нашлись похожие товары и сгенерируй НОВЫЕ запросы:
- Убери слова из doNotSearch/canDrop
- Используй marketSynonyms и частотные слова из карточка товара
- Попробуй другие формулировки
- Только русский, 2-4 слова

JSON: {"newQueries": ["запрос1", "запрос2", ...], "reason": "почему предыдущие запросы не сработали"}`;

  try {
    const result = await callLlm(prompt, 'Ты Search Repair Agent. Исправляешь поисковые запросы. ТОЛЬКО JSON.');
    const queries = validateQueries(
      (result?.newQueries ?? []).map((q: string) => ({ query: q, purpose: 'repair', priority: 1 }))
    );
    return { newQueries: queries, reason: result?.reason ?? '' };
  } catch {
    return { newQueries: [], reason: 'repair failed' };
  }
}

// ─── Query Validator ─────────────────────────────────────────────────────────

const JUNK = /новинка|опт|горячая|хит|популярн|бестселлер|модн|тренд|премиум|professional|super|bright|outdoor|portable|ультра|мощный|дальний свет|четырёхъядерный|четырехъядерный/i;
const CN = /[一-鿿]/;
const EN = /[a-zA-Z]{4,}/;

export function validateQueries(queries: Array<string | { query: string }>): string[] {
  return queries
    .map(q => (typeof q === 'string' ? q : q.query).trim())
    .filter(q => {
      if (q.length < 3 || q.length > 60) return false;
      if (CN.test(q)) return false;
      if (EN.test(q) && !/\d/.test(q)) return false;
      if (q.split(/\s+/).length > 5) return false;
      if (JUNK.test(q)) return false;
      return true;
    })
    .filter((q, i, arr) => arr.indexOf(q) === i);
}

// ─── Legacy exports for compatibility ────────────────────────────────────────
export { analyzeProduct as understandAndPlan };
export async function refineQueries(structure: ProductStructure, topTitles: string[]): Promise<string[]> {
  const tokens = extractFrequentTokens(topTitles);
  return expandQueries(structure, tokens.tokens, tokens.bigrams);
}

function extractFrequentTokens(titles: string[]): { tokens: string[]; bigrams: string[] } {
  const freq = new Map<string, number>();
  const bigramFreq = new Map<string, number>();
  for (const title of titles) {
    const words = title.toLowerCase().replace(/[^а-яёa-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
    for (let i = 0; i < words.length - 1; i++) {
      const bg = `${words[i]} ${words[i + 1]}`;
      bigramFreq.set(bg, (bigramFreq.get(bg) ?? 0) + 1);
    }
  }
  const tokens = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(e => e[0]);
  const bigrams = [...bigramFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => e[0]);
  return { tokens, bigrams };
}
