import type { ProductContext, AiContentResult } from '../types';

const SYNTHESIS_MODELS = [
  'deepseek/deepseek-v4-flash',
  'google/gemini-2.5-flash-lite-preview-09-2025',
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
      .replace(/\b(?:NaN|undefined|null)\b/gi, '—')
      .replace(/\b0(?:[,.]0+)?\s*[¥￥]/gi, 'цена уточняется')
      .replace(/\b0(?:[,.]0+)?\s*₽/gi, 'цена уточняется')
      .replace(/\b0(?:[,.]0+)?\s*(?:кг|kg)\b/gi, 'вес уточняется')
      .replace(/\d+([,.]\d{4,})/g, (match) => {
        const parsed = Number(match.replace(',', '.'));
        return Number.isFinite(parsed) ? String(Math.round(parsed * 100) / 100).replace('.', ',') : '—';
      })
      .replace(/\s+/g, ' ')
      .trim();
}

function stripChinesePublicText(text: unknown): string {
  return normalizeText(text).replace(/[一-鿿]+/g, '').replace(/\s{2,}/g, ' ').trim();
}

function isSuspiciousCharacteristicMapping(name: string, val: string): boolean {
  const key = name.toLowerCase();
  const value = val.toLowerCase();
  const colorValue = /(?:красн|ж[её]лт|син|зел[её]н|ч[её]рн|черн|бел|розов|серый|red|yellow|blue|green|black|white|pink|红|黄|蓝|绿|黑|白)/i;
  const numericField = /(?:мощность|напряжение|вольт|ватт|аккумулятор|батар|ёмкость|емкость|ток|частота|размер|вес|длина|ширина|высота|диаметр|power|voltage|battery|capacity)/i;
  const colorField = /(?:цвет|color)/i;
  const electricValue = /(?:\d+\s*(?:w|вт|v|в|mah|мач|hz|гц)|usb|type-c|аккумулятор|батар)/i;
  if (numericField.test(key) && colorValue.test(value) && !/\d/.test(value)) return true;
  if (colorField.test(key) && electricValue.test(value)) return true;
  return false;
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
      if (isSuspiciousCharacteristicMapping(name, val)) continue;

      // Если модель пометила как небезопасное для WB — не кладём в characteristics.
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
      if (isSuspiciousCharacteristicMapping(name, val)) continue;

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
- медицинские/лечебные свойства;
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

  return `Ты — товарный редактор Wildberries и закупочный аналитик.

Твоя задача — создать БЕЗОПАСНЫЙ черновик WB-карточки по данным товара с 1688.

Важно:
- Это не рекламная фантазия.
- Нельзя придумывать свойства.
- Нельзя писать неподтверждённые характеристики как факт.
- Если данных не хватает, добавь это в needsClarification.
- Если свойство относится только к части SKU, не пиши его как свойство всего товара.
- Если цена, вес, SKU или рынок WB предварительные — учитывай это в warnings, но не превращай в рекламный текст.
- Текст должен быть похож на карточку WB, а не на машинный перевод 1688.

ДАННЫЕ ТОВАРА:
Тип товара: ${ctx.identity?.productType ?? ''}
Категория: ${ctx.identity?.categoryType ?? ''}
Короткое название: ${ctx.titles?.shortRu ?? ''}
Черновик WB-названия: ${ctx.titles?.wbTitleDraft ?? ''}
Сценарии использования: ${(ctx.identity?.useCases ?? []).join(', ')}

ФАКТЫ О ТОВАРЕ:
${JSON.stringify(safeFacts, null, 2)}

РАЗРЕШЁННЫЕ CLAIMS:
${allowedClaims.length ? allowedClaims.map((x) => `- ${x}`).join('\n') : '- нет явных разрешённых claims'}

ЗАПРЕЩЁННЫЕ CLAIMS:
${forbiddenClaims.length ? forbiddenClaims.map((x) => `- ${x}`).join('\n') : '- нет'}

РИСКИ:
${riskTags.length ? riskTags.map((x) => `- ${x}`).join('\n') : '- нет'}

КАЧЕСТВО ДАННЫХ:
Статус: ${ctx.dataQuality?.status ?? 'unknown'}
Оценка: ${ctx.dataQuality?.score ?? 0}/10

WB-РЫНОК:
Подтверждённые локальные аналоги: ${market.confirmedCount}
Медиана WB: ${market.medianPrice ? `${market.medianPrice} ₽` : 'не определена'}
Рынок подтверждён: ${market.hasMarket ? 'да' : 'нет'}
${market.wb429 ? 'WB временно ограничил поиск.' : ''}

ЭКОНОМИКА:
Себестоимость: ${economics.costRub > 0 ? `${economics.costRub} ₽` : 'не рассчитана'}
ROI: ${economics.roiPercent ?? 'не рассчитан'}
Вес: ${economics.weightMissing ? 'не указан' : 'есть'}
Режим: ${economics.platformMode}

КАТЕГОРИЙНЫЕ ПРАВИЛА:
${categoryRules}

ЗАДАЧА:
Сгенерируй JSON для WB-карточки.

Верни СТРОГО JSON без markdown:
{
  "titleRu": "",
  "description": "",
  "bullets": [],
  "keywords": [],
  "characteristics": {
    "Тип": "",
    "Материал": ""
  },
  "needsClarification": [],
  "warnings": [],
  "forbiddenRemoved": [],
  "confidence": "high|medium|low"
}

ПРАВИЛА TITLE:
- 50–90 символов.
- Рыночное название для WB.
- Без китайских слов.
- Без брендов, если бренд не подтверждён.
- Без неподтверждённых свойств.
- Не использовать слова из другой категории.
- Не перегружать title длинным переводом 1688.

ПРАВИЛА DESCRIPTION:
- 2–4 предложения.
- Продающий, но осторожный текст.
- Используй только confirmed или безопасные inferred свойства.
- Не обещай лечебный, профессиональный, сертифицированный, оригинальный, премиальный эффект, если это не подтверждено.
- Не упоминай 1688, поставщика, закупочную цену и внутреннюю экономику.

ПРАВИЛА BULLETS:
- Ровно 5 коротких буллетов.
- Каждый буллет должен быть полезен для инфографики.
- Не повторять одно и то же.
- Не писать свойства, которых нет в allowedClaims/facts.

ПРАВИЛА KEYWORDS:
- 10–15 ключей.
- Только релевантные запросы WB.
- Не добавлять бренды без подтверждения.
- Не добавлять другой тип товара.
- Не добавлять слишком широкие или конфликтующие слова.

ПРАВИЛА CHARACTERISTICS:
- Только характеристики, безопасные для WB.
- Не писать свойства одного SKU как свойства всего товара.
- Если характеристика не подтверждена — не добавляй её в characteristics, добавь в needsClarification.

ПРАВИЛА WARNINGS:
Добавь warning, если:
- цена предварительная;
- SKU не подтверждён;
- вес отсутствует;
- рынок WB не подтверждён;
- качество данных ниже 7/10;
- есть риск смешанных SKU.

ПРАВИЛА NEEDS CLARIFICATION:
Добавь всё, что нужно уточнить перед публикацией WB-карточки или закупкой.

ФИНАЛЬНАЯ ПРОВЕРКА:
Перед ответом проверь:
- нет китайских слов;
- нет forbiddenClaims;
- нет характеристик из чужой категории;
- нет неподтверждённых свойств как фактов;
- title не похож на машинный перевод 1688.
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
      stripChinesePublicText(parsed.titleRu) ||
      stripChinesePublicText(ctx.titles?.wbTitleDraft) ||
      stripChinesePublicText(ctx.titles?.shortRu) ||
      stripChinesePublicText(ctx.titles?.cleanRu) ||
      'Товар для Wildberries';

  return {
    titleRu,
    description: stripChinesePublicText(parsed.description),
    bullets: asStringArray(parsed.bullets, 5).map(stripChinesePublicText).filter(Boolean),
    keywords: asStringArray(parsed.keywords, 15).map(stripChinesePublicText).filter(Boolean),
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
          'Ты создаёшь безопасный черновик WB-карточки.',
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
    signal: AbortSignal.timeout(15_000),
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
      stripChinesePublicText(ctx.titles?.wbTitleDraft) ||
      stripChinesePublicText(ctx.titles?.shortRu) ||
      stripChinesePublicText(ctx.titles?.cleanRu) ||
      'Товар для Wildberries';

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