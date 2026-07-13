import type { ProductContext, AiContentResult } from '../types';

const SYNTHESIS_MODELS = [
  'google/gemini-3.1-flash-lite',
  'qwen/qwen3.7-plus',
];

type MarketInput = {
  confirmedCount: number;
  medianPrice: number | null;
  hasMarket: boolean;
  wb429: boolean;
};

type EconomicsInput = {
  costRub: number;
  roiPercent: number | null;
  weightMissing: boolean;
  platformMode: string;
};

type RawSeoResult = {
  titleRu?: string;
  description?: string;
  bullets?: string[];
  keywords?: string[];
  characteristics?: Record<string, string> | Array<{
    name?: string;
    value?: string;
    source?: string;
    safeForWb?: boolean;
  }>;
  needsClarification?: string[];
  warnings?: string[];
  forbiddenRemoved?: string[];
  confidence?: 'high' | 'medium' | 'low';
};

function cleanJson(raw: string): string {
  return String(raw ?? '')
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
}

function containsChinese(text: unknown): boolean {
  return /[一-鿿]/.test(String(text ?? ''));
}

function normalizeText(text: unknown): string {
  return String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
}

function uniqStrings(items: unknown[], limit = 50): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of items) {
    const s = normalizeText(item);
    if (!s) continue;

    const key = s.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }

  return out;
}

function asStringArray(value: unknown, limit = 20): string[] {
  if (!Array.isArray(value)) return [];
  return uniqStrings(value, limit);
}

function collectSeoText(parsed: RawSeoResult): string {
  const chars = normalizeCharacteristics(parsed.characteristics);

  return [
    parsed.titleRu,
    parsed.description,
    ...(parsed.bullets ?? []),
    ...(parsed.keywords ?? []),
    ...Object.entries(chars).flatMap(([k, v]) => [k, v]),
    ...(parsed.warnings ?? []),
    ...(parsed.needsClarification ?? []),
  ]
      .map((x) => String(x ?? ''))
      .join(' ')
      .toLowerCase();
}

function containsForbiddenClaim(parsed: RawSeoResult, forbiddenClaims: string[]): string[] {
  const text = collectSeoText(parsed);
  const found: string[] = [];

  for (const claim of forbiddenClaims ?? []) {
    const c = normalizeText(claim).toLowerCase();
    if (!c || c.length < 2) continue;
    if (text.includes(c)) found.push(claim);
  }

  return found;
}

function normalizeCharacteristics(
    value: RawSeoResult['characteristics'],
): Record<string, string> {
  const out: Record<string, string> = {};

  if (!value) return out;

  if (Array.isArray(value)) {
    for (const row of value) {
      const name = normalizeText(row?.name);
      const val = normalizeText(row?.value);

      if (!name || !val) continue;
      if (containsChinese(name) || containsChinese(val)) continue;

      // Если модель пометила как небезопасное для карточка товара — не кладём в characteristics.
      if (row.safeForWb === false) continue;

      out[name] = val;
    }
    return out;
  }

  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const name = normalizeText(k);
      const val = normalizeText(v);

      if (!name || !val) continue;
      if (containsChinese(name) || containsChinese(val)) continue;

      out[name] = val;
    }
  }

  return out;
}

function buildSafeFacts(ctx: ProductContext): Record<string, unknown> {
  const facts = ctx.facts ?? {};
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(facts)) {
    const key = normalizeText(k);
    if (!key) continue;
    if (containsChinese(key)) continue;

    if (typeof v === 'string') {
      const val = normalizeText(v);
      if (!val || containsChinese(val)) continue;
      out[key] = val;
      continue;
    }

    if (Array.isArray(v)) {
      const arr = (v as unknown[])
          .map((x) => normalizeText(x))
          .filter((x) => x && !containsChinese(x));

      if (arr.length) out[key] = uniqStrings(arr, 20);
      continue;
    }

    if (typeof v === 'number' || typeof v === 'boolean') {
      out[key] = v;
    }
  }

  return out;
}

function buildCategoryRules(categoryType: string): string {
  const cat = String(categoryType ?? '').toLowerCase();

  const common = `
Общие правила:
- Не пиши свойства, которых нет в facts или allowedClaims.
- Если свойство относится только к части SKU, не пиши его как свойство всего товара.
- Если свойство не подтверждено, добавь его в needsClarification, а не в описание.
- Не добавляй бренды, если бренд не подтверждён.
- Не добавляй китайские слова, транслит китайских терминов и raw-перевод 1688.
`;

  if (
      cat.includes('clothing') ||
      cat.includes('apparel') ||
      cat.includes('одеж') ||
      cat.includes('textile')
  ) {
    return `${common}
Категория: одежда.
Можно:
- материал, цвет, размер, назначение, сезон, посадка, особенности кроя;
- спортивное/повседневное назначение, если это подтверждено.

Нельзя:
- мощность, напряжение, аккумулятор, тип вилки, зарядка;
- регулируемые спецсвойства без документов;
- "утягивает", "корректирует фигуру", если это не подтверждено.

Обязательно добавить в needsClarification, если нет данных:
- точный состав ткани в процентах;
- размерная сетка и замеры изделия;
- плотность ткани;
- просвечивает ли ткань при растяжении;
- уход/стирка;
- бирки и маркировка;
- вес с упаковкой.
`;
  }

  if (
      cat.includes('shoes') ||
      cat.includes('footwear') ||
      cat.includes('обув')
  ) {
    return `${common}
Категория: обувь.
Можно:
- тип обуви, материал верха, материал подошвы, сезон, назначение, размерный ряд.

Нельзя:
- мощность, напряжение, аккумулятор, тип вилки;
- состав ткани в процентах, рукав, усадка ткани.

Обязательно добавить в needsClarification, если нет данных:
- размерная сетка;
- длина стельки;
- материал верха и подошвы;
- вес пары с упаковкой;
- размер упаковки;
- запах материала;
- реальные фото;
- MOQ по цветам и размерам.
`;
  }

  if (
      cat.includes('electronics') ||
      cat.includes('electric') ||
      cat.includes('техник') ||
      cat.includes('электрон')
  ) {
    return `${common}
Категория: техника / электроника.
Можно:
- мощность, напряжение, тип питания, аккумулятор, комплектация, режимы, разъём, сертификаты.

Нельзя:
- размерная сетка;
- длина стельки;
- состав ткани;
- усадка после стирки;
- плотность ткани.

Обязательно добавить в needsClarification, если нет данных:
- мощность;
- напряжение;
- тип питания;
- аккумулятор и ёмкость, если есть;
- комплектация;
- сертификаты;
- гарантия;
- инструкция;
- вес и размер упаковки.
`;
  }

  return common;
}

function buildPrompt(
    ctx: ProductContext,
    market: MarketInput,
    economics: EconomicsInput,
): string {
  const safeFacts = buildSafeFacts(ctx);
  const allowedClaims = uniqStrings(ctx.seoPolicy?.allowedClaims ?? [], 80);
  const forbiddenClaims = uniqStrings(ctx.seoPolicy?.forbiddenClaims ?? [], 80);
  const riskTags = uniqStrings(ctx.riskTags ?? [], 50);
  const categoryRules = buildCategoryRules(ctx.identity?.categoryType ?? '');

  return `CardZip 2.0 SEO Writer.

Сделай безопасный, продающий черновик карточки товара по данным 1688. Это не закупочная аналитика и не расчёт себестоимости.

Данные:
- Тип: ${ctx.identity?.productType ?? ''}
- Категория: ${ctx.identity?.categoryType ?? ''}
- Название: ${ctx.titles?.shortRu ?? ''}
- черновик карточки: ${ctx.titles?.wbTitleDraft ?? ''}
- Сценарии: ${(ctx.identity?.useCases ?? []).join(', ')}
- Facts: ${JSON.stringify(safeFacts)}
- Allowed claims: ${allowedClaims.join(', ') || 'нет'}
- Forbidden claims: ${forbiddenClaims.join(', ') || 'нет'}
- Риски: ${riskTags.join(', ') || 'нет'}
- Качество данных: ${ctx.dataQuality?.status ?? 'unknown'}, ${ctx.dataQuality?.score ?? 0}/10
- Себестоимость: ${economics.costRub > 0 ? economics.costRub + ' ₽' : 'не рассчитана'}; вес: ${economics.weightMissing ? 'не указан' : 'есть'}

Категорийные правила:
${categoryRules}

Верни только JSON:
{
  "titleRu": "50-90 символов, без брендов и неподтверждённых claims",
  "description": "2-4 предложения: что это, для чего, ключевые подтверждённые свойства; спорное — осторожно",
  "bullets": ["3–5 коротких буллетов для карточки/инфографики, только факты, без воды"],
  "keywords": ["10-15 релевантных запросов"],
  "characteristics": {"Тип":"...", "Материал":"..."},
  "needsClarification": ["что уточнить перед публикацией/закупкой"],
  "warnings": ["цена/SKU/вес/контекст закупки/claims, если актуально"],
  "forbiddenRemoved": ["что не использовано как факт"],
  "confidence": "high|medium|low"
}

Правила:
- Не упоминай 1688, поставщика, закупочную цену, показатель и внутреннюю экономику в SEO.
- Не добавляй другой тип товара или чужую категорию.
- Не пиши forbiddenClaims как факт; перенеси в needsClarification/forbiddenRemoved.
- Не превращай claim одного SKU в свойство всего товара.
- Нет китайских слов, markdown и пояснений вне JSON.
`;
}

function buildRepairPrompt(
    originalPrompt: string,
    previousJson: RawSeoResult,
    errors: string[],
): string {
  return `${originalPrompt}

Твой предыдущий JSON содержит ошибки:
${errors.map((e) => `- ${e}`).join('\n')}

Исправь JSON.
Правила:
- Не добавляй новых неподтверждённых свойств.
- Удали китайские слова.
- Удали forbiddenClaims.
- Удали характеристики из чужой категории.
- Верни только валидный JSON без markdown.

ПРЕДЫДУЩИЙ JSON:
${JSON.stringify(previousJson, null, 2)}
`;
}

function validateSeoResult(parsed: RawSeoResult, ctx: ProductContext): string[] {
  const errors: string[] = [];
  const forbidden = ctx.seoPolicy?.forbiddenClaims ?? [];

  if (!normalizeText(parsed.titleRu)) {
    errors.push('Нет titleRu.');
  }

  if (containsChinese(parsed.titleRu)) {
    errors.push('В titleRu есть китайские символы.');
  }

  if (containsChinese(parsed.description)) {
    errors.push('В description есть китайские символы.');
  }

  for (const b of parsed.bullets ?? []) {
    if (containsChinese(b)) errors.push(`В bullet есть китайские символы: ${b}`);
  }

  for (const k of parsed.keywords ?? []) {
    if (containsChinese(k)) errors.push(`В keyword есть китайские символы: ${k}`);
  }

  const chars = normalizeCharacteristics(parsed.characteristics);
  for (const [k, v] of Object.entries(chars)) {
    if (containsChinese(k) || containsChinese(v)) {
      errors.push(`В characteristics есть китайские символы: ${k}: ${v}`);
    }
  }

  const foundForbidden = containsForbiddenClaim(parsed, forbidden);
  if (foundForbidden.length) {
    errors.push(`Найдены forbiddenClaims: ${foundForbidden.join(', ')}`);
  }

  const title = normalizeText(parsed.titleRu);
  if (title.length > 120) {
    errors.push('titleRu слишком длинный.');
  }

  return uniqStrings(errors, 20);
}

function normalizeSeoResult(parsed: RawSeoResult, ctx: ProductContext): AiContentResult {
  const needsClarification = asStringArray(parsed.needsClarification, 20);
  const warnings = asStringArray(parsed.warnings, 20);

  const mergedWarnings = uniqStrings([
    ...warnings,
    ...needsClarification.map((x) => `Уточнить: ${x}`),
  ], 30);

  const titleRu =
      normalizeText(parsed.titleRu) ||
      ctx.titles?.wbTitleDraft ||
      ctx.titles?.shortRu ||
      ctx.titles?.cleanRu;

  return {
    titleRu,
    description: normalizeText(parsed.description),
    bullets: asStringArray(parsed.bullets, 5),
    keywords: asStringArray(parsed.keywords, 15),
    characteristics: normalizeCharacteristics(parsed.characteristics),
    warnings: mergedWarnings,
  };
}

async function callOpenRouter(
    apiKey: string,
    model: string,
    prompt: string,
    useJsonResponseFormat: boolean,
): Promise<RawSeoResult | null> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: 2500,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: [
          'Ты создаёшь безопасный черновик карточки товара.',
          'Ты не придумываешь свойства.',
          'Ты возвращаешь только валидный JSON.',
        ].join('\n'),
      },
      { role: 'user', content: prompt },
    ],
  };

  if (useJsonResponseFormat) {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(32_000),
  });

  if (!res.ok) return null;

  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content ?? '';
  if (!content) return null;

  return JSON.parse(cleanJson(content)) as RawSeoResult;
}

async function runModel(
    apiKey: string,
    model: string,
    prompt: string,
): Promise<RawSeoResult | null> {
  // Сначала пробуем strict JSON mode.
  try {
    const parsed = await callOpenRouter(apiKey, model, prompt, true);
    if (parsed) return parsed;
  } catch {
    // ignore and retry without response_format
  }

  // Некоторые модели/роуты могут не поддерживать response_format.
  try {
    return await callOpenRouter(apiKey, model, prompt, false);
  } catch {
    return null;
  }
}

export async function synthesizeReport(
    ctx: ProductContext,
    market: MarketInput,
    economics: EconomicsInput,
): Promise<AiContentResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return fallbackSeo(ctx);

  const prompt = buildPrompt(ctx, market, economics);

  for (const model of SYNTHESIS_MODELS) {
    try {
      const parsed = await runModel(apiKey, model, prompt);
      if (!parsed?.titleRu) continue;

      const errors = validateSeoResult(parsed, ctx);

      if (!errors.length) {
        const result = normalizeSeoResult(parsed, ctx);
        console.log(`[synthesis] SEO: ${result.titleRu.slice(0, 40)}`);
        return result;
      }

      // Один repair-pass, если модель вернула JSON, но он грязный.
      const repairPrompt = buildRepairPrompt(prompt, parsed, errors);
      const repaired = await runModel(apiKey, model, repairPrompt);

      if (repaired?.titleRu) {
        const repairedErrors = validateSeoResult(repaired, ctx);
        if (!repairedErrors.length) {
          const result = normalizeSeoResult(repaired, ctx);
          console.log(`[synthesis] SEO repaired: ${result.titleRu.slice(0, 40)}`);
          return result;
        }
      }

      console.warn(`[synthesis] ${model} rejected: ${errors.join('; ')}`);
    } catch (err) {
      console.warn(`[synthesis] ${model} failed`, err);
      continue;
    }
  }

  return fallbackSeo(ctx);
}

function fallbackSeo(ctx: ProductContext): AiContentResult {
  const safeFacts = buildSafeFacts(ctx);
  const safeTitle =
      normalizeText(ctx.titles?.wbTitleDraft) ||
      normalizeText(ctx.titles?.shortRu) ||
      normalizeText(ctx.titles?.cleanRu) ||
      'Товар для карточка товара';

  return {
    titleRu: safeTitle,
    description: '',
    bullets: [],
    keywords: [],
    characteristics: Object.fromEntries(Object.entries(safeFacts).map(([k, v]) => [k, String(v ?? '')])),
    warnings: [
      'SEO сгенерирован в fallback-режиме. Перед публикацией проверьте характеристики.',
    ],
    isFallback: true,
  };
}