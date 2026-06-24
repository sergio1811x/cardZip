export type KitType = 'body_only' | 'basic_kit' | 'full_kit' | 'unknown';

export interface ProductStructure {
  category: string;
  productType: string;
  subtype: string | null;
  coreIntent: string;
  mustHaveFeatures: string[];
  importantFeatures: string[];
  optionalFeatures: string[];
  technicalSpecs: Record<string, string>;
  negativeMatches: string[];
  kitType: KitType;
  kitContents: string[];
  confidence: number;
}

export interface WbQueryPlan {
  queries: Array<{ query: string; purpose: string; priority: number }>;
  requiredConcepts: string[][];
  bonusConcepts: string[][];
  excludeIfOnlyMatch: string[][];
}

const SYSTEM_PROMPT = `Ты — аналитик товаров из Китая. Анализируй данные с 1688/Taobao и выдавай структуру товара на русском.`;

function buildUnderstandingPrompt(raw: {
  titleCn: string;
  titleEn?: string;
  categoryName?: string;
  attributes?: Array<{ name: string; value: string }>;
  description?: string;
  skus?: Array<{ name: string; price?: number }>;
}): string {
  let info = `Название (CN): ${raw.titleCn}`;
  if (raw.titleEn) info += `\nНазвание (EN): ${raw.titleEn}`;
  if (raw.categoryName) info += `\nКатегория 1688: ${raw.categoryName}`;
  if (raw.attributes?.length) {
    info += '\nХарактеристики:';
    raw.attributes.slice(0, 20).forEach(a => { info += `\n  ${a.name}: ${a.value}`; });
  }
  if (raw.description) info += `\nОписание: ${raw.description.slice(0, 300)}`;
  if (raw.skus?.length) {
    info += '\nВарианты SKU:';
    raw.skus.slice(0, 8).forEach(s => { info += `\n  ${s.name} — ${s.price ?? '?'} ¥`; });
  }

  return `Проанализируй товар и верни JSON.

ДАННЫЕ:
${info}

Верни ТОЛЬКО JSON:
{
  "category": "категория на русском (Автотовары, Одежда, Электроника, ...)",
  "productType": "тип товара на русском (пусковое устройство, леггинсы, зонт, ...)",
  "subtype": "подтип или null (с компрессором, складной автомат, ...)",
  "coreIntent": "зачем покупают (аварийный запуск автомобиля, защита от дождя, ...)",
  "mustHaveFeatures": ["обязательные признаки для аналога"],
  "importantFeatures": ["важные, но не обязательные"],
  "optionalFeatures": ["второстепенные (цвет, чехол, ...)"],
  "technicalSpecs": {"ключ": "значение"},
  "negativeMatches": ["что НЕ является этим товаром, но может попасть в выдачу"],
  "kitType": "body_only|basic_kit|full_kit|unknown",
  "kitContents": ["что входит в комплект: батарея, чехол, насадки, зарядка и т.д."],
  "confidence": 0.0-1.0
}`;
}

function buildQueryPrompt(structure: ProductStructure): string {
  return `На основе структуры товара сгенерируй 5-8 коротких русских поисковых запросов для Wildberries.

ТОВАР:
Категория: ${structure.category}
Тип: ${structure.productType}
Подтип: ${structure.subtype ?? 'нет'}
Назначение: ${structure.coreIntent}
Обязательные признаки: ${structure.mustHaveFeatures.join(', ')}
Важные признаки: ${structure.importantFeatures.join(', ')}
Не аналоги: ${structure.negativeMatches.join(', ')}

ПРАВИЛА:
- Только русский язык. Никакого английского и китайского.
- Каждый запрос 2-4 слова.
- Типы запросов: базовый (категория), функциональный (с ключевой функцией), синоним, технический (с параметром).
- НЕ включай: "новинка", "опт", "горячая продажа", "хит", "популярный".
- НЕ переводи дословно с китайского.
- requiredConcepts: группы синонимов, хотя бы одно слово из группы ОБЯЗАТЕЛЬНО в карточке.
- excludeIfOnlyMatch: если карточка содержит ТОЛЬКО эти слова без requiredConcepts — исключить.

Верни ТОЛЬКО JSON:
{
  "queries": [
    {"query": "запрос", "purpose": "broad_market|functional_match|synonym|technical_match", "priority": 1-3}
  ],
  "requiredConcepts": [["синоним1", "синоним2"]],
  "bonusConcepts": [["доп.признак1", "доп.признак2"]],
  "excludeIfOnlyMatch": [["слово которое без основного товара = мусор"]]
}`;
}

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

async function callLlm(prompt: string, systemMsg: string): Promise<any> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const model = process.env.CONTENT_MODEL || 'google/gemini-2.5-flash-lite-preview-09-2025';

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) return null;
  const data = await res.json() as any;
  const raw = data.choices?.[0]?.message?.content ?? '';
  return JSON.parse(cleanJson(raw));
}

export async function understandProduct(raw: {
  titleCn: string;
  titleEn?: string;
  categoryName?: string;
  attributes?: Array<{ name: string; value: string }>;
  description?: string;
  skus?: Array<{ name: string; price?: number }>;
}): Promise<ProductStructure | null> {
  try {
    const prompt = buildUnderstandingPrompt(raw);
    const result = await callLlm(prompt, SYSTEM_PROMPT);
    if (!result?.productType) return null;
    return {
      category: result.category ?? '',
      productType: result.productType ?? '',
      subtype: result.subtype ?? null,
      coreIntent: result.coreIntent ?? '',
      mustHaveFeatures: result.mustHaveFeatures ?? [],
      importantFeatures: result.importantFeatures ?? [],
      optionalFeatures: result.optionalFeatures ?? [],
      technicalSpecs: result.technicalSpecs ?? {},
      negativeMatches: result.negativeMatches ?? [],
      kitType: result.kitType ?? 'unknown',
      kitContents: result.kitContents ?? [],
      confidence: result.confidence ?? 0.5,
    };
  } catch (e) {
    console.error('[understand] Failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

export async function planQueries(structure: ProductStructure): Promise<WbQueryPlan | null> {
  try {
    const prompt = buildQueryPrompt(structure);
    const result = await callLlm(prompt, 'Ты генератор поисковых запросов для Wildberries. Отвечай ТОЛЬКО JSON.');
    if (!result?.queries?.length) return null;
    return {
      queries: result.queries ?? [],
      requiredConcepts: result.requiredConcepts ?? [],
      bonusConcepts: result.bonusConcepts ?? [],
      excludeIfOnlyMatch: result.excludeIfOnlyMatch ?? [],
    };
  } catch (e) {
    console.error('[queryPlan] Failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

// ─── Query Validator ─────────────────────────────────────────────────────────

const JUNK_WORDS = /новинка|опт|горячая|хит|популярн|бестселлер|модн|тренд/i;
const HAS_CHINESE = /[一-鿿]/;
const HAS_ENGLISH = /[a-zA-Z]{3,}/;

export function validateQueries(queries: Array<{ query: string; purpose: string; priority: number }>): string[] {
  return queries
    .map(q => q.query.trim())
    .filter(q => {
      if (q.length < 3 || q.length > 60) return false;
      if (HAS_CHINESE.test(q)) return false;
      if (HAS_ENGLISH.test(q) && !/\d/.test(q)) return false; // allow "12v" but not "jump starter"
      if (q.split(/\s+/).length > 5) return false;
      if (JUNK_WORDS.test(q)) return false;
      return true;
    })
    .filter((q, i, arr) => arr.indexOf(q) === i);
}
