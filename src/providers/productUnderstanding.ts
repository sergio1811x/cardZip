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
          model, max_tokens: 3000, temperature: 0.2,
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
          max_tokens: 3000, temperature: 0.2,
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

  const prompt = `Ты анализируешь товар с 1688 для продажи на Wildberries.

Твоя задача:
1. Понять, что это за товар.
2. Определить категорию товара.
3. Дать короткое рыночное название на русском.
4. Подготовить структуру для поиска аналогов на Wildberries.

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
    "requiredAttributes": ["обязательные признаки для прямого аналога"],
    "importantAttributes": ["важные но не обязательные"],
    "optionalAttributes": ["второстепенные"],
    "subType": "узкий подтип (короткий складной кошелек, настольный USB вентилятор, ...)",
    "lengthClass": "short|long|compact|full_size|unknown",
    "shapeType": "форма (bifold, trifold, long_wallet, clutch, cardholder, ...)",
    "closureType": "тип застёжки (button, zipper, magnet, none, unknown)",
    "visualStyle": ["визуальный стиль (мультяшное тиснение, минимализм, ...)"],
    "hardFormConflicts": ["жёсткие конфликты по подтипу/форме (женский клатч, сумка, ...)"],
    "softFormConflicts": ["мягкие конфликты подтипа (длинное портмоне, кошелек для документов, органайзер, travel wallet, кошелек с ремешком, ...)"],
    "hardConflicts": ["если найдено → товар точно НЕ аналог"],
    "softConflicts": ["похожие но другие товары"],
    "compatibleAlternatives": ["допустимые рыночные альтернативы (портмоне мужское, бумажник мужской, ...)"],
    "categoryHypotheses": ["гипотезы WB-категорий"],
    "searchIntent": "что ищет покупатель на WB",
    "mustKeep": ["признаки, которые НЕЛЬЗЯ убирать из поиска"],
    "canDrop": ["признаки, которые МОЖНО убрать если поиск слишком узкий (артикул, модель, редкий цвет, ...)"],
    "doNotSearch": ["слова, которые НЕ НАДО использовать в WB-запросах (артикулы, модели, маркетинг, китайские фразы)"],
    "marketSynonyms": ["как товар может называться на WB"],
    "directAnalogBlockers": ["что запрещает считать товар прямым аналогом"],
    "kitType": "body_only|basic_kit|full_kit|unknown",
    "kitContents": [],
    "confidence": 0.0-1.0
  },
  "lexicon": {
    "mainTerms": ["основные термины товара"],
    "alternateNames": ["синонимы (портмоне, бумажник, ...)"],
    "marketNames": ["как товар называется на рынке WB"],
    "buyerSearchTerms": ["как покупатели ищут на WB"],
    "attributeTerms": ["ключевые атрибуты"],
    "materialAliases": ["все варианты написания материала"],
    "hardNegativeTerms": ["слова-маркеры нерелевантных товаров"],
    "softNegativeTerms": ["маркеры похожих но не аналогичных"],
    "broadCategoryTerms": ["широкие категорийные термины"]
  },
  "wbCoreQuery": "рыночный запрос WB 1-3 слова, конкретный подтип, не широкий",
  "queryLadder": {
    "L1_exact": ["точные запросы: productType + ключевые атрибуты, 2-4 слова"],
    "L2_commercial": ["запросы языком покупателя WB, как ищет обычный человек"],
    "L3_subtype": ["запросы по подтипу/формату товара"],
    "L4_core": ["запросы по базовому объекту + широкий признак"],
    "L5_category": ["самые широкие категорийные запросы, 1-2 слова"]
  }
}

Правила:
- categoryType выбирай только из списка.
- wbCoreQuery: 1-3 слова, как товар реально ищут на WB.
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
          model, max_tokens: 4000, temperature: 0.2,
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

const INTELLIGENCE_PROMPT = `Ты — товарный аналитик для маркетплейса Wildberries.

Тебе дан товар с 1688. Если приложено фото — используй его для визуального анализа. Твоя задача:
1. Понять, что это за товар (по тексту И по фото, если есть).
2. Очистить смысл от китайского мусора и машинного перевода.
3. Дать чистые названия (CN без мусора, RU рыночное, для отчёта, для WB).
4. Определить, как этот товар называют на Wildberries.
5. Определить видимые на фото характеристики (visibleFeatures).
6. Определить, с чем товар можно спутать (possibleConfusions).
7. Определить, какие характеристики важны именно для этого товара.
8. Определить, какие вопросы поставщику нужно задать.
9. Определить, какие темы нельзя спрашивать, потому что они не относятся к товару.
10. Определить, что можно и нельзя писать в SEO.
11. Сформировать короткие поисковые запросы WB.

Верни строго JSON без markdown:

{
  "productIdentity": {
    "marketNameRu": "рыночное название на русском, как на WB",
    "shortNameRu": "короткое название 2-4 слова",
    "productKind": "конкретный тип (домашние тапочки, настольный вентилятор, нож-секач)",
    "categoryPath": ["Обувь", "Домашняя обувь", "Тапочки"],
    "categoryType": "shoes|clothes|electronics|home|beauty|accessory|kitchen|other",
    "subCategoryType": "конкретная подкатегория (тапочки домашние, USB-вентилятор настольный)",
    "audience": "мужской/женский/детский/унисекс",
    "useCases": ["дом", "дача", "пляж"],
    "coreObject": "базовый объект (тапочки, вентилятор, нож)",
    "formFactor": "форм-фактор (закрытые, складной, настольный)",
    "material": ["EVA", "PVC"],
    "powerType": ["USB", "аккумулятор", "сеть 220V", "без питания"],
    "season": "лето/зима/всесезон/не применимо",
    "gender": "мужской/женский/унисекс",
    "ageGroup": "взрослый/детский/все",
    "importantFeatures": ["нескользящая подошва", "закрытый носок"],
    "notConfirmedFeatures": ["ортопедическая стелька — не подтверждено"],
    "visibleFeatures": ["закрытый носок", "рифлёная подошва", "логотип на стельке"],
    "possibleConfusions": ["пляжные шлёпанцы", "медицинские тапочки", "ортопедические сабо"]
  },

  "cleanTitles": {
    "titleCnClean": "убери маркетинг и мусор из CN-названия, оставь суть",
    "titleRuClean": "чистое русское название без мусора",
    "titleForReport": "название для отчёта, 3-6 слов, понятное байеру",
    "titleForWb": "как товар назвали бы на WB, 2-4 слова"
  },

  "wbSearch": {
    "wbCoreQuery": "1-3 слова, рыночный запрос WB",
    "queryCandidates": ["запрос1", "запрос2", "запрос3"],
    "negativeSearchTerms": ["кожаные", "ортопедические"],
    "tooBroadQueries": ["обувь", "тапки"],
    "tooNarrowQueries": ["тапочки домашние женские зимние меховые с вышивкой"]
  },

  "matchingRules": {
    "mustHaveForDirectAnalog": ["домашние тапочки", "закрытый носок"],
    "allowedDifferences": ["цвет", "рисунок"],
    "directAnalogBlockers": ["открытый носок", "уличные"],
    "similarOnlyIf": ["другой материал подошвы"],
    "rejectIf": ["сандалии", "кроссовки", "ботинки"]
  },

  "reportRules": {
    "buyerMustCheck": ["вес пары с упаковкой", "размерная сетка", "длина стельки"],
    "buyerMustNotAsk": ["мощность", "напряжение", "аккумулятор", "рукав"],
    "seoAllowedClaims": ["домашние", "тёплые", "нескользящие", "мягкие"],
    "seoForbiddenClaims": ["ортопедические", "медицинские", "натуральная кожа"],
    "importantAttributesToShow": ["материал верха", "материал подошвы", "сезон"],
    "attributesToHide": ["артикул", "складской код", "тип торговли"],
    "riskFlags": ["вес не указан", "размерная сетка не подтверждена"]
  },

  "supplierQuestions": {
    "ru": ["Какой вес пары с упаковкой?", "Пришлите размерную сетку"],
    "cn": ["一双鞋带包装的重量是多少？", "请提供厘米尺寸表"]
  },

  "dataQuality": {
    "missingCriticalFields": ["вес", "размерная сетка"],
    "skuRisk": "mixed_sku — разные типы в одной карточке",
    "priceRisk": "ok",
    "weightRisk": "missing",
    "overallConfidence": "medium",
    "visionConfidence": "high/medium/low/none — насколько фото помогло определить товар",
    "textConfidence": "high/medium/low — насколько текстовые данные достаточны",
    "reason": "цена есть, но вес и стелька не указаны"
  }
}

ПРИМЕРЫ:

Для обуви (categoryType=shoes, тапочки/сабо/шлёпанцы):
- visibleFeatures: закрытый носок, рифлёная подошва, EVA-материал, без каблука
- possibleConfusions: пляжные шлёпанцы, медицинские тапочки, ортопедические сабо
- buyerMustNotAsk: мощность, напряжение, аккумулятор, тип вилки, рукав, плотность ткани, усадка
- seoForbiddenClaims: ортопедические (если не подтверждено), натуральная кожа (если EVA)

Для USB-устройства (categoryType=electronics):
- visibleFeatures: USB-разъём, кнопка включения, светодиод, компактный размер
- possibleConfusions: power bank, зарядное устройство, колонка
- buyerMustNotAsk: размерная сетка, длина стельки, рукав, ткань, усадка
- buyerMustCheck: тип разъёма, ёмкость аккумулятора, время работы, мощность
- seoForbiddenClaims: 220V (если USB 5V), бесшумный (если не подтверждено)

Для техники от сети (categoryType=electronics):
- visibleFeatures: сетевой шнур, вилка, индикатор, корпус пластик
- possibleConfusions: другие приборы похожей формы

Для одежды (categoryType=clothes):
- visibleFeatures: тип ткани, крой, застёжка, декоративные элементы
- possibleConfusions: похожие модели другого назначения
- buyerMustNotAsk: мощность, напряжение, длина стельки, тип вилки
- buyerMustCheck: состав ткани, плотность, размерная сетка, замеры, усадка

Правила:
- Не возвращай китайские слова в русских полях.
- Не транслитерируй китайские термины.
- Переводи смысл на нормальный русский язык.
- Не придумывай неподтверждённые свойства.
- visibleFeatures: ТОЛЬКО то, что реально видно на фото. Если фото нет — пустой массив.
- possibleConfusions: товары, которые ПОХОЖИ но НЕ являются этим товаром.
- cleanTitles: убери из CN-названия маркетинг (踩屎感, 爆款, 网红), оставь суть товара.
- wbCoreQuery: 1–3 слова, как реально ищут на WB.
- queryCandidates: короткие, рыночные запросы.
- visionConfidence: "high" если фото позволило уверенно определить товар, "medium" если фото помогло частично, "low" если фото малоинформативно, "none" если фото не предоставлено.`;

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
  const systemMsg = 'Ты — товарный аналитик для Wildberries. Анализируешь товары с 1688. Верни СТРОГО JSON.';

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
  const prompt = `На основе товара и частотных слов из WB сгенерируй 5-10 ДОПОЛНИТЕЛЬНЫХ русских запросов.

ТОВАР: ${structure.productType} (${structure.coreObject})
Аудитория: ${structure.audience}

Частотные слова WB: ${frequentTokens.slice(0, 15).join(', ')}
Частотные биграммы WB: ${frequentBigrams.slice(0, 10).join(', ')}

Сгенерируй запросы которых НЕ было в первом поиске. Используй реальные WB-термины.
Только русский, 2-4 слова. JSON: {"queries": ["запрос1", "запрос2"]}`;

  try {
    const result = await callLlm(prompt, 'Генератор WB-запросов. ТОЛЬКО JSON.');
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
  const prompt = `Оцени, является ли WB-карточка аналогом товара.

ТОВАР:
Тип: ${source.productType}
Объект: ${source.coreObject}
Аудитория: ${source.audience}
Обязательные: ${source.requiredAttributes.join(', ')}
Важные: ${source.importantAttributes.join(', ')}
Жёсткие конфликты: ${source.hardConflicts.join(', ')}
Мягкие конфликты: ${source.softConflicts.join(', ')}
Допустимые альтернативы: ${source.compatibleAlternatives.join(', ')}

WB-КАРТОЧКА:
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

  const prompt = `Оцени ${candidates.length} WB-карточек — являются ли они аналогами товара.

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
  const prompt = `Ты Search Repair Agent. Поиск WB не нашёл достаточно прямых аналогов.

ТОВАР: ${structure.productType} (${structure.coreObject})
Подтип: ${structure.subType || 'нет'}
mustKeep: ${structure.mustKeep?.join(', ') || 'нет'}
canDrop: ${structure.canDrop?.join(', ') || 'нет'}
doNotSearch: ${structure.doNotSearch?.join(', ') || 'нет'}
marketSynonyms: ${structure.marketSynonyms?.join(', ') || 'нет'}

Попробованные запросы: ${queriesTried.join(' | ')}

Топ найденных карточек: ${topFoundTitles.slice(0, 8).join(' | ')}
Топ отклонённых карточек: ${topRejectedTitles.slice(0, 5).join(' | ')}

Частотные слова WB: ${mining.tokens.slice(0, 10).join(', ')}
Частотные биграммы WB: ${mining.bigrams.slice(0, 5).join(', ')}

Проанализируй почему не нашлись аналоги и сгенерируй НОВЫЕ запросы:
- Убери слова из doNotSearch/canDrop
- Используй marketSynonyms и частотные слова из WB
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
