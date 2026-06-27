import type { ProductContext } from '../types';

const VISION_MODELS = [
  'google/gemini-2.5-flash-lite-preview-09-2025',
];

const TEXT_MODELS = [
  'google/gemini-2.5-flash-lite-preview-09-2025',
  'deepseek/deepseek-v4-flash',
];

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

const CANONICALIZER_PROMPT = `Ты — товарный аналитик для маркетплейса Wildberries.

Тебе дан товар с 1688. Используй текстовые данные и изображение (если есть) чтобы понять товар.

Верни строго JSON без markdown:

{
  "identity": {
    "productType": "конкретный тип товара на русском",
    "coreObject": "базовый объект (тапочки, вентилятор, нож)",
    "categoryType": "shoes|clothes|electronics|home|beauty|accessory|kitchen|fishing|tools|other",
    "useCases": ["дом", "пляж"],
    "notThis": ["не спасательный буй", "не навигационный"],
    "audience": "унисекс/мужской/женский/детский",
    "season": "лето/зима/всесезон/не применимо",
    "gender": "мужской/женский/унисекс"
  },
  "titles": {
    "titleCn": "оригинальное китайское название без мусора",
    "cleanRu": "чистое русское название",
    "shortRu": "короткое 2-4 слова",
    "wbTitleDraft": "SEO-название для карточки WB"
  },
  "facts": {
    "материал": "EVA",
    "цвет": "чёрный"
  },
  "sku": {
    "hasMultipleSku": true,
    "skuCount": 8,
    "knownOptions": ["S чёрный", "M розовый"],
    "needsSelection": true
  },
  "price": {
    "visiblePriceCny": 36,
    "minPriceCny": 34,
    "maxPriceCny": 47,
    "source": "sku_range",
    "needsConfirmation": true
  },
  "conflicts": [
    {"field": "power", "problem": "значение похоже на цвет", "severity": "high", "action": "не выводить как мощность"}
  ],
  "missingCritical": ["вес с упаковкой", "размерная сетка"],
  "wbSearch": {
    "coreQuery": "тапочки домашние зимние",
    "queryLadder": ["тапочки домашние", "тапочки зимние"],
    "mustInclude": ["тапочки", "домашние"],
    "mustExclude": ["летние", "открытые"],
    "directMatchRules": ["домашние тапочки закрытого типа"],
    "rejectRules": ["сандалии", "кроссовки", "уличные"]
  },
  "seoPolicy": {
    "allowedClaims": ["тёплые", "нескользящие", "домашние"],
    "forbiddenClaims": ["ортопедические", "медицинские"]
  },
  "supplierQuestions": {
    "ru": ["Какой вес пары с упаковкой?", "Пришлите размерную сетку"],
    "cn": ["一双鞋带包装的重量是多少？", "请提供厘米尺寸表"]
  },
  "riskTags": ["вес не указан", "SKU не выбран"],
  "dataQuality": {
    "score": 6,
    "status": "working_hypothesis",
    "explanation": "цена есть, но вес и стелька не указаны"
  }
}

Правила:
- Не возвращай китайские слова в русских полях.
- Переводи смысл, не транслитерируй.
- facts должны содержать только переведённые и подтверждённые характеристики.
- conflicts — если текст и фото конфликтуют или атрибут неправильно замаплен.
- Используй изображение только для понимания типа товара и визуальных признаков.
- supplierQuestions: конкретные вопросы по этому товару, 8-12 штук.
- wbSearch.coreQuery: 1-3 слова, как реально ищут на WB.
- seoPolicy.forbiddenClaims: неподтверждённые свойства.

Для обуви: не спрашивать мощность/напряжение/рукав.
Для техники: не спрашивать размерную сетку/стельку.
Для одежды: не спрашивать мощность/напряжение.`;

export async function canonicalizeProduct(raw: {
  offerId: string;
  titleCn: string;
  titleRu?: string;
  titleEn?: string;
  categoryName?: string;
  attributes?: Array<{ name: string; value: string }>;
  skus?: Array<{ name: string; price?: number; stock?: number }>;
  price?: number;
  priceRange?: Array<{ minQty: number; maxQty: number; price: number }>;
  weightKg?: number;
  mainImageUrl?: string;
  sold?: number;
  stock?: number;
}): Promise<ProductContext | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  // Build info string
  let info = `Товар с 1688 (offerId: ${raw.offerId}):\n`;
  info += `Название CN: ${raw.titleCn}\n`;
  if (raw.titleRu) info += `Название RU: ${raw.titleRu}\n`;
  if (raw.titleEn) info += `Название EN: ${raw.titleEn}\n`;
  if (raw.categoryName) info += `Категория: ${raw.categoryName}\n`;
  if (raw.price) info += `Цена: ${raw.price} ¥\n`;
  if (raw.priceRange?.length) {
    info += 'Оптовые цены:\n';
    raw.priceRange.forEach(r => { info += `  ${r.minQty}+ шт: ${r.price} ¥\n`; });
  }
  if (raw.weightKg) info += `Вес: ${raw.weightKg} кг\n`;
  if (raw.sold) info += `Продажи: ${raw.sold}\n`;
  if (raw.stock) info += `Остаток: ${raw.stock}\n`;
  if (raw.attributes?.length) {
    info += 'Атрибуты:\n';
    raw.attributes.slice(0, 20).forEach(a => { info += `  ${a.name}: ${a.value}\n`; });
  }
  if (raw.skus?.length) {
    info += `SKU (${raw.skus.length}):\n`;
    raw.skus.slice(0, 10).forEach(s => { info += `  ${s.name} — ${s.price ?? '?'} ¥ (ост: ${s.stock ?? '?'})\n`; });
  }

  const prompt = `${CANONICALIZER_PROMPT}\n\nДанные товара:\n${info}`;
  const systemMsg = 'Ты — товарный аналитик. Верни СТРОГО JSON.';

  let result: any = null;

  // Try vision first
  if (raw.mainImageUrl) {
    try {
      const imgRes = await fetch(raw.mainImageUrl, { signal: AbortSignal.timeout(5000) });
      if (imgRes.ok) {
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        if (buffer.length < 500_000) {
          const base64 = buffer.toString('base64');
          for (const model of VISION_MODELS) {
            try {
              const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  model, max_tokens: 4000, temperature: 0.2,
                  messages: [
                    { role: 'system', content: systemMsg },
                    { role: 'user', content: [
                      { type: 'text', text: prompt },
                      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
                    ]},
                  ],
                }),
                signal: AbortSignal.timeout(25_000),
              });
              if (!res.ok) continue;
              const data = await res.json() as any;
              result = JSON.parse(cleanJson(data.choices?.[0]?.message?.content ?? ''));
              if (result?.identity) break;
            } catch { continue; }
          }
        }
      }
    } catch {}
  }

  // Text-only fallback
  if (!result?.identity) {
    for (const model of TEXT_MODELS) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model, max_tokens: 4000, temperature: 0.2,
            messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: prompt }],
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) continue;
        const data = await res.json() as any;
        result = JSON.parse(cleanJson(data.choices?.[0]?.message?.content ?? ''));
        if (result?.identity) break;
      } catch { continue; }
    }
  }

  if (!result?.identity) return null;

  // Safe mapping
  const ctx: ProductContext = {
    offerId: raw.offerId,
    identity: {
      productType: result.identity.productType ?? '',
      coreObject: result.identity.coreObject ?? '',
      categoryType: result.identity.categoryType ?? 'other',
      useCases: result.identity.useCases ?? [],
      notThis: result.identity.notThis ?? [],
      audience: result.identity.audience ?? '',
      season: result.identity.season ?? '',
      gender: result.identity.gender ?? '',
    },
    titles: {
      titleCn: result.titles?.titleCn ?? raw.titleCn,
      cleanRu: result.titles?.cleanRu ?? '',
      shortRu: result.titles?.shortRu ?? '',
      wbTitleDraft: result.titles?.wbTitleDraft ?? '',
    },
    facts: result.facts ?? {},
    sku: {
      hasMultipleSku: result.sku?.hasMultipleSku ?? false,
      skuCount: result.sku?.skuCount ?? 0,
      knownOptions: result.sku?.knownOptions ?? [],
      needsSelection: result.sku?.needsSelection ?? false,
    },
    price: {
      visiblePriceCny: result.price?.visiblePriceCny ?? null,
      minPriceCny: result.price?.minPriceCny ?? null,
      maxPriceCny: result.price?.maxPriceCny ?? null,
      source: result.price?.source ?? '',
      needsConfirmation: result.price?.needsConfirmation ?? true,
    },
    conflicts: result.conflicts ?? [],
    missingCritical: result.missingCritical ?? [],
    wbSearch: {
      coreQuery: result.wbSearch?.coreQuery ?? '',
      queryLadder: result.wbSearch?.queryLadder ?? [],
      mustInclude: result.wbSearch?.mustInclude ?? [],
      mustExclude: result.wbSearch?.mustExclude ?? [],
      directMatchRules: result.wbSearch?.directMatchRules ?? [],
      rejectRules: result.wbSearch?.rejectRules ?? [],
    },
    seoPolicy: {
      allowedClaims: result.seoPolicy?.allowedClaims ?? [],
      forbiddenClaims: result.seoPolicy?.forbiddenClaims ?? [],
    },
    supplierQuestions: {
      ru: result.supplierQuestions?.ru ?? [],
      cn: result.supplierQuestions?.cn ?? [],
    },
    riskTags: result.riskTags ?? [],
    dataQuality: {
      score: result.dataQuality?.score ?? 3,
      status: result.dataQuality?.status ?? 'draft',
      explanation: result.dataQuality?.explanation ?? '',
    },
  };

  console.log(`[canonicalizer] ${ctx.titles.shortRu || ctx.identity.productType} | cat: ${ctx.identity.categoryType} | quality: ${ctx.dataQuality.score}/10`);
  return ctx;
}
