export type KitType = 'body_only' | 'basic_kit' | 'full_kit' | 'unknown';

export interface ProductStructure {
  productFamily: string;
  productType: string;
  coreNoun: string;
  formFactor: string;
  modifiers: string[];
  powerType: string[];
  useCase: string[];
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

// Поиск и структура: Gemini → Llama → DeepSeek
const SEARCH_MODELS = [
  'google/gemini-2.5-flash-lite-preview-09-2025',
  'meta-llama/llama-4-scout',
  'deepseek/deepseek-v4-flash',
];

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

async function callLlm(prompt: string, systemMsg: string, models?: string[]): Promise<any> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  for (const model of (models ?? SEARCH_MODELS)) {
    try {
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

      if (!res.ok) {
        console.warn(`[llm] ${model} HTTP ${res.status}`);
        continue;
      }
      const data = await res.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(cleanJson(raw));
      if (parsed) return parsed;
    } catch (e) {
      console.warn(`[llm] ${model} failed:`, e instanceof Error ? e.message : e);
    }
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
          max_tokens: 2000, temperature: 0.3,
          messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        return JSON.parse(cleanJson(data.choices?.[0]?.message?.content ?? ''));
      }
    } catch {}
  }

  return null;
}

// ─── Product Understanding ───────────────────────────────────────────────────

export async function understandProduct(raw: {
  titleCn: string;
  titleEn?: string;
  categoryName?: string;
  attributes?: Array<{ name: string; value: string }>;
  description?: string;
  skus?: Array<{ name: string; price?: number }>;
}): Promise<ProductStructure | null> {
  let info = `Название (CN): ${raw.titleCn}`;
  if (raw.titleEn) info += `\nНазвание (EN): ${raw.titleEn}`;
  if (raw.categoryName) info += `\nКатегория 1688: ${raw.categoryName}`;
  if (raw.attributes?.length) {
    info += '\nХарактеристики:';
    raw.attributes.slice(0, 20).forEach(a => { info += `\n  ${a.name}: ${a.value}`; });
  }
  if (raw.description) info += `\nОписание: ${raw.description.slice(0, 300)}`;
  if (raw.skus?.length) {
    info += '\nSKU:';
    raw.skus.slice(0, 8).forEach(s => { info += `\n  ${s.name} — ${s.price ?? '?'} ¥`; });
  }

  const prompt = `Проанализируй товар. Верни ТОЛЬКО JSON:
{
  "productFamily": "категория (Автотовары, Одежда, Электроника, Дом, Аксессуары, ...)",
  "productType": "полный тип (аккумуляторная минимойка, складной зонт автомат, ...)",
  "coreNoun": "главное существительное (мойка, зонт, вентилятор, леггинсы, ...)",
  "formFactor": "форм-фактор (настольный, напольный, ручной, складной, портативный, ...)",
  "modifiers": ["ключевые прилагательные (аккумуляторная, автоматический, ...)"],
  "powerType": ["тип питания (USB, аккумулятор, сеть 220V, батарейки, ...)"],
  "useCase": ["назначение (для дома, для авто, для офиса, для спорта, ...)"],
  "subtype": "подтип или null",
  "coreIntent": "зачем покупают",
  "mustHaveFeatures": ["обязательные признаки аналога"],
  "importantFeatures": ["важные но не обязательные"],
  "optionalFeatures": ["второстепенные"],
  "technicalSpecs": {"ключ": "значение"},
  "negativeMatches": ["что НЕ является этим товаром но может попасть в выдачу"],
  "kitType": "body_only|basic_kit|full_kit|unknown",
  "kitContents": ["что входит в комплект"],
  "confidence": 0.0-1.0
}

ДАННЫЕ:
${info}`;

  try {
    const result = await callLlm(prompt, 'Ты аналитик товаров из Китая. Отвечай ТОЛЬКО JSON.');
    if (!result?.coreNoun) return null;
    return {
      productFamily: result.productFamily ?? '',
      productType: result.productType ?? '',
      coreNoun: result.coreNoun ?? '',
      formFactor: result.formFactor ?? '',
      modifiers: result.modifiers ?? [],
      powerType: result.powerType ?? [],
      useCase: result.useCase ?? [],
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
    console.error('[understand]', e instanceof Error ? e.message : e);
    return null;
  }
}

// ─── Query Planner ───────────────────────────────────────────────────────────

export async function planQueries(structure: ProductStructure): Promise<WbQueryPlan | null> {
  const prompt = `Сгенерируй 5-8 коротких русских запросов для поиска на Wildberries.

ТОВАР: ${structure.productType}
Семейство: ${structure.productFamily}
Главное слово: ${structure.coreNoun}
Модификаторы: ${structure.modifiers.join(', ')}
Назначение: ${structure.coreIntent}
Обязательные: ${structure.mustHaveFeatures.join(', ')}
Не аналоги: ${structure.negativeMatches.join(', ')}

ПРАВИЛА:
- Только русский, 2-4 слова на запрос.
- Типы: базовый, функциональный, синоним, технический.
- НЕ: "новинка", "опт", "хит", китайский, английский.

JSON:
{
  "queries": [{"query": "...", "purpose": "broad|functional|synonym|technical", "priority": 1-3}],
  "requiredConcepts": [["синоним1", "синоним2"]],
  "bonusConcepts": [["доп.признак"]],
  "excludeIfOnlyMatch": [["слово без основного товара = мусор"]]
}`;

  try {
    const result = await callLlm(prompt, 'Генератор запросов для WB. ТОЛЬКО JSON.');
    if (!result?.queries?.length) return null;
    return {
      queries: result.queries ?? [],
      requiredConcepts: result.requiredConcepts ?? [],
      bonusConcepts: result.bonusConcepts ?? [],
      excludeIfOnlyMatch: result.excludeIfOnlyMatch ?? [],
    };
  } catch (e) {
    console.error('[queryPlan]', e instanceof Error ? e.message : e);
    return null;
  }
}

// ─── Query Refiner (второй проход) ──────────────────────────────────────────

export async function refineQueries(
  structure: ProductStructure,
  topCardTitles: string[]
): Promise<string[]> {
  const prompt = `На основе товара и найденных карточек WB сгенерируй 3-4 ДОПОЛНИТЕЛЬНЫХ уточняющих запроса.

ТОВАР: ${structure.productType} (${structure.coreNoun})
Модификаторы: ${structure.modifiers.join(', ')}

Найденные карточки WB (топ):
${topCardTitles.slice(0, 10).map((t, i) => `${i + 1}. ${t}`).join('\n')}

Сгенерируй синонимы, подтипы и уточнения которых НЕ было в первом поиске.
Только русский, 2-4 слова. Верни JSON: {"queries": ["запрос1", "запрос2", "запрос3"]}`;

  try {
    const result = await callLlm(prompt, 'Генератор уточняющих запросов. ТОЛЬКО JSON.');
    return validateQueries(
      (result?.queries ?? []).map((q: string) => ({ query: q, purpose: 'refined', priority: 2 }))
    );
  } catch {
    return [];
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
      if (HAS_ENGLISH.test(q) && !/\d/.test(q)) return false;
      if (q.split(/\s+/).length > 5) return false;
      if (JUNK_WORDS.test(q)) return false;
      return true;
    })
    .filter((q, i, arr) => arr.indexOf(q) === i);
}
