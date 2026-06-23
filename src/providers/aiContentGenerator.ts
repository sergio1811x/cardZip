import { z } from 'zod';
import type { AiContentGenerator, AiContentRequest, AiContentResult } from '../types';

const MODELS = [
  process.env.CONTENT_MODEL || 'deepseek/deepseek-v4-flash',
  process.env.FALLBACK_MODEL || 'xiaomi/mimo-v2.5',
  process.env.SECONDARY_FALLBACK_MODEL || 'google/gemini-2.5-flash-lite-preview-09-2025',
];

const AiResponseSchema = z.object({
  titleRu: z.string().min(10).max(150),
  titleRuBranded: z.string().optional(),
  description: z.string().min(100).max(3000),
  bullets: z.array(z.string()).min(3).max(5),
  keywords: z.array(z.string()).min(1).max(10),
  characteristics: z.record(z.union([z.string(), z.number()]).transform(String)),
  filterKeywords: z.object({
    required: z.array(z.string()),
    optional: z.array(z.string()),
    exclude: z.array(z.string()),
  }).optional(),
  searchQueries: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  supplierQuestions: z.object({
    ru: z.array(z.string()).min(5).max(12),
    cn: z.array(z.string()).min(5).max(12),
  }).optional(),
});

const BANNED_CLAIMS = [
  'тихий', 'бесшумный', 'безопасный', 'антибактериальный', 'гипоаллергенный',
  'сертифицированный', 'лечебный', 'экологичный', 'премиальный', 'для детей',
  'гарантия качества', 'долговечный', 'безвредный', 'натуральный', 'органический',
];

function stripBannedClaims(text: string, confirmed: string[]): string {
  const confirmedLower = confirmed.map((c) => c.toLowerCase());
  for (const claim of BANNED_CLAIMS) {
    if (confirmedLower.some((c) => c.includes(claim))) continue;
    const re = new RegExp(`\\b${claim}(?:ая|ый|ое|ие|ой|ого|ому)?\\b`, 'gi');
    text = text.replace(re, '').replace(/\s{2,}/g, ' ').trim();
  }
  return text;
}

function buildFallback(req: AiContentRequest): AiContentResult {
  return {
    titleRu: req.titleEn || req.titleCn,
    description: `Товар с 1688. Цена: ${req.priceYuan} юаней. Мин. заказ: ${req.moq} шт.${req.weightKg ? ` Вес: ${req.weightKg} кг.` : ''}`,
    bullets: [],
    keywords: [],
    characteristics: {
      'Цена поставщика': `${req.priceYuan} юаней`,
      'Минимальный заказ': `${req.moq} шт.`,
      ...(req.weightKg ? { 'Вес': `${req.weightKg} кг` } : {}),
    },
    isFallback: true,
  };
}

function buildPrompt(req: AiContentRequest): string {
  let productInfo = `- Название (кит.): ${req.titleCn}`;
  if (req.titleEn) productInfo += `\n- Название (англ.): ${req.titleEn}`;
  if (req.categoryName) productInfo += `\n- Категория: ${req.categoryName}`;
  productInfo += `\n- Цена: ${req.priceYuan} юаней`;
  productInfo += `\n- Минимальный заказ: ${req.moq} шт.`;
  productInfo += `\n- Вес: ${req.weightKg || 'не указан'} кг`;
  productInfo += `\n- Поставщик: ${req.supplierName}${req.supplierRating ? ` (рейтинг: ${req.supplierRating})` : ''}`;

  if (req.brand) productInfo += `\n- Бренд поставщика: ${req.brand}`;
  if (req.model) productInfo += `\n- Модель: ${req.model}`;

  if (req.confirmedFeatures?.length) {
    productInfo += '\n\nПодтверждённые свойства товара:';
    req.confirmedFeatures.forEach((f) => { productInfo += `\n- ${f}`; });
  }

  if (req.missingFields?.length) {
    productInfo += '\n\nОтсутствующие данные (нельзя упоминать как факт):';
    req.missingFields.forEach((f) => { productInfo += `\n- ${f}`; });
  }

  if (req.attributes?.length) {
    productInfo += '\n\nХарактеристики от поставщика:';
    req.attributes.slice(0, 20).forEach((a) => {
      productInfo += `\n- ${a.name}: ${a.value}`;
    });
  }

  if (req.description) {
    productInfo += `\n\nОписание от поставщика:\n${req.description.slice(0, 500)}`;
  }

  const brandBlock = req.brand
    ? `\nБРЕНД:
- В titleRu НЕ включай бренд "${req.brand}" — дай нейтральное название.
- В titleRuBranded включи оригинальное обозначение поставщика: "${req.brand}${req.model ? ' ' + req.model : ''}".`
    : '';

  const riskBlock = req.riskFlags
    ? `\nРИСКИ (учти при генерации):
${req.riskFlags.isElectrical ? '- Электротовар: не пиши "безопасный", не утверждай про сертификаты\n' : ''}${req.riskFlags.isChildren ? '- Детский товар: не пиши "для детей" без подтверждения\n' : ''}${req.riskFlags.isCosmetic ? '- Косметика: не пиши про состав, который не подтверждён\n' : ''}${req.riskFlags.isFood ? '- Пищевой товар: не пиши про полезные свойства\n' : ''}${req.riskFlags.isMedical ? '- Медицинский товар: не пиши про лечебные свойства\n' : ''}`
    : '';

  const wbKeywordsBlock = req.wbTopKeywords?.length
    ? `\nКЛЮЧЕВЫЕ СЛОВА ИЗ ТОПА WB (интегрируй в текст естественно):
${req.wbTopKeywords.slice(0, 10).map(k => `- ${k}`).join('\n')}`
    : '';

  const platformContext = req.platform === 'taobao'
    ? 'Товар с Taobao (розница). Описание — черновик. Пиши консервативно, не утверждай качество фабрики.'
    : req.platform === 'tmall'
    ? 'Товар с Tmall (бренд). НЕ используй бренд в названии. Пиши нейтрально.'
    : 'Товар с 1688 (оптовая площадка). Пиши для продажи на WB.';

  return `Ты — копирайтер для маркетплейса Wildberries. Режим: Safe Listing — пиши ТОЛЬКО подтверждённые факты.

КОНТЕКСТ:
${platformContext}
Селлер закупает товар в Китае и продаёт на Wildberries в России.

ДАННЫЕ ТОВАРА:
${productInfo}
${brandBlock}
${riskBlock}
${wbKeywordsBlock}
СТИЛЬ ТЕКСТА (Safe Listing):
- Нейтральный, информативный тон. Короткие абзацы.
- Описывай только подтверждённые свойства: материал, размер, цвет, комплектация, назначение.
- НЕ пиши эмоциональный копирайтинг: "не упустите", "закажите сейчас", "лучший", "идеальный".
- НЕ придумывай сценарии использования без подтверждения.
- НЕ обещай качество, безопасность или результат.
- НЕ пиши канцеляризмы: "в качестве материала используется", "предназначен для эксплуатации".
- Ключевые слова из WB интегрируй в текст естественно, без переспама.

СТРОГИЕ ЗАПРЕТЫ:
- НЕ придумывай свойства, которых нет в данных поставщика. LLM не может добавлять характеристики.
- НЕ используй: тихий, бесшумный, безопасный, антибактериальный, гипоаллергенный, сертифицированный, лечебный, экологичный, премиальный, долговечный, идеальный, трендовый, лучший.
- НЕ пиши "для детей" без подтверждения.
- НЕ включай B2B-платформы и внутренние метки 1688.
- Если данных о свойстве нет — НЕ упоминай его.
- НЕ используй бренд поставщика в titleRu, keywords, characteristics. Наличие поля 品牌 НЕ означает OEM.
- НЕ пиши "OEM" если нет подтверждения (无品牌, OEM, 可贴牌, 可定制, 无标, 可去标).
- Иероглифы в характеристиках → переводи, НЕ транслитерируй.
- 中腰 = средняя посадка (НЕ "высокая талия"). 宽松型 = свободный крой (НЕ "палаццо"). 九分裤 = укороченные (НЕ "длинные").
- Если перевод вызывает сомнения — ставь "(требует уточнения)" рядом.

ЗАДАЧИ:
1. titleRu — название для WB, максимум 120 символов. Только: категория, пол, крой, материал, сезон, посадка, цвет — если подтверждены. БЕЗ бренда, БЕЗ "OEM", БЕЗ рекламных слов.${req.brand ? '\n2. titleRuBranded — оригинальное обозначение поставщика (только для справки, НЕ для WB)' : ''}
3. description — нейтральное описание 500-1000 символов:
   - Что это, материал, размеры (только подтверждённые)
   - Назначение и комплектация если известны
   - Финал: "Перед публикацией уточните размерную таблицу выбранного SKU и состав."
   - БЕЗ призывов, обещаний, выдуманных свойств.
4. bullets — ровно 5 тезисов (5-10 слов), БЕЗ эмодзи, только подтверждённые свойства
5. keywords — 8-15 поисковых запросов WB. Без бренда. Без синонимов меняющих тип товара.
6. characteristics — характеристики из данных поставщика, переведённые на русский
7. filterKeywords — ключевые слова для фильтрации товаров WB:
   - required: 1-2 обязательных слова категории (напр. "вентилятор")
   - optional: 3-5 уточняющих слов (напр. "usb", "настольный", "мини")
   - exclude: 3-8 слов для исключения нерелевантных товаров (напр. "напольный", "потолочный")
8. searchQueries — 3 поисковых запроса для ручной проверки на WB
9. warnings — массив 1-4 СТРОГО релевантных предупреждений для этого КОНКРЕТНОГО товара:
   - Одежда/Обувь: "Размеры могут маломерить. Запросите размерную сетку в сантиметрах."
   - Электроника: "Проверьте тип вилки (Евро/Китай), рабочее напряжение (220V) и необходимость сертификата."
   - Хрупкое (стекло/керамика): "Высокий риск боя. Требуется усиленная обрешётка при карго доставке."
   - Косметика/БАД: "Требуется декларация соответствия и регистрация в Роспотребнадзоре."
   - Детские товары: "Обязательна сертификация. Проверьте требования ТР ТС."
   - НЕ добавляй предупреждения для НЕРЕЛЕВАНТНЫХ категорий (не пиши про размеры для электроники).
   - Объединяй смысловые дубликаты. Максимум 3 самых критичных пункта. Не пиши воду.
10. supplierQuestions — вопросы поставщику на ДВУХ языках (ru и cn).
   Площадка: ${req.platform ?? '1688'}.
   ПРАВИЛА:
   - Максимум 7 вопросов, максимум 1200 символов на китайском.
   - НЕ спрашивай то, что уже есть в данных товара.
   - НЕ обещай крупный заказ. НЕ пиши "мы крупная компания".
   - Короткие нумерованные пункты.
   ${req.platform === '1688' ? '- Спрашивай: цену на 20/50/100 шт., вес с упаковкой (если нет), наличие, срок, реальные фото, нейтральную упаковку + категорийные вопросы.' : ''}
   ${req.platform === 'taobao' ? '- Обязательно: "Есть ли цена при покупке 20/50/100 штук?" и "Есть ли вы на 1688?"' : ''}
   ${req.platform === 'tmall' ? '- Обязательно: "Можно без бренда?", "Есть OEM версия?", "Можно для перепродажи?", "Есть оптовая цена?"' : ''}
   - Китайская версия начинается с "您好，我想采购这个产品，请问：" и пригодна для копирования.

Верни ТОЛЬКО JSON:
{
  "titleRu": "...",${req.brand ? '\n  "titleRuBranded": "...",' : ''}
  "description": "...",
  "bullets": ["...", "...", "...", "...", "..."],
  "keywords": ["...", "..."],
  "characteristics": {"ключ": "значение"},
  "filterKeywords": {"required": [...], "optional": [...], "exclude": [...]},
  "searchQueries": ["запрос 1", "запрос 2", "запрос 3"],
  "warnings": ["Релевантное предупреждение для этого товара"],
  "supplierQuestions": {
    "ru": ["1. Можно ли заказать образец?", "2. ...", "..."],
    "cn": ["您好，我想采购这个产品，请问：", "1. 可以先订样品吗？", "2. ...", "..."]
  }
}`;
}

function cleanJsonResponse(raw: string): string {
  return raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

async function callModel(model: string, prompt: string, apiKey: string): Promise<AiContentResult | null> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/sergio1811x/cardZip',
        'X-Title': 'cardZip',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        temperature: 0.7,
        messages: [
          {
            role: 'system',
            content: 'Ты SEO-копирайтер для Wildberries. Отвечаешь ТОЛЬКО валидным JSON. Никакого Markdown, никаких пояснений — только JSON-объект.',
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.error(`[ai] ${model} HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(cleanJsonResponse(raw));
    const validated = AiResponseSchema.parse(parsed);
    return validated as AiContentResult;
  } catch (e) {
    console.error(`[ai] ${model} failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

function postProcess(result: AiContentResult, req: AiContentRequest): AiContentResult {
  const confirmed = req.confirmedFeatures ?? [];

  result.description = stripBannedClaims(result.description, confirmed);
  result.bullets = result.bullets.map((b) => stripBannedClaims(b, confirmed));

  return result;
}

async function generate(req: AiContentRequest): Promise<AiContentResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY не задан');

  const prompt = buildPrompt(req);

  for (const model of MODELS) {
    console.log(`[ai] Trying ${model}...`);
    const result = await callModel(model, prompt, apiKey);
    if (result) {
      console.log(`[ai] Success with ${model}`);
      return postProcess(result, req);
    }
  }

  console.error('[ai] All models failed, using fallback');
  return buildFallback(req);
}

export const aiContentGenerator: AiContentGenerator = { generate };
