import { z } from 'zod';
import type { AiContentGenerator, AiContentRequest, AiContentResult } from '../types';

const MODELS = [
  process.env.CONTENT_MODEL || 'deepseek/deepseek-v4-flash',
  process.env.FALLBACK_MODEL || 'xiaomi/mimo-v2.5',
  process.env.SECONDARY_FALLBACK_MODEL || 'google/gemini-2.5-flash-lite-preview-09-2025',
];

const AiResponseSchema = z.object({
  titleRu: z.string().min(10).max(200),
  description: z.string().min(100).max(3000),
  bullets: z.array(z.string()).min(3).max(5),
  keywords: z.array(z.string()).min(1).max(10),
  characteristics: z.record(z.union([z.string(), z.number()]).transform(String)),
});

function buildFallback(req: AiContentRequest): AiContentResult {
  return {
    titleRu: req.titleEn || req.titleCn,
    description: `Товар с 1688. Цена: ${req.priceYuan} юаней. Мин. заказ: ${req.moq} шт. Вес: ${req.weightKg} кг.`,
    bullets: [],
    keywords: [],
    characteristics: {
      'Цена поставщика': `${req.priceYuan} юаней`,
      'Минимальный заказ': `${req.moq} шт.`,
      'Вес': `${req.weightKg} кг`,
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

  if (req.attributes?.length) {
    productInfo += '\n\nХарактеристики от поставщика:';
    req.attributes.slice(0, 20).forEach((a) => {
      productInfo += `\n- ${a.name}: ${a.value}`;
    });
  }

  if (req.description) {
    productInfo += `\n\nОписание от поставщика:\n${req.description.slice(0, 500)}`;
  }

  return `Ты — SEO-копирайтер для маркетплейса Wildberries. Твоя задача — создать готовый контент для карточки товара на WB на основе данных от китайского поставщика.

КОНТЕКСТ:
Селлер закупает товар в Китае (1688/Taobao) и продаёт на Wildberries в России. Ему нужен:
1. Коммерческое название карточки — с ключевыми словами, по которым покупатели ищут на WB
2. SEO-описание — чтобы карточка поднималась в поиске WB
3. 5 буллетов — короткие тезисы о преимуществах для инфографики на главном фото
4. Ключевые слова — поисковые запросы, по которым товар найдут на WB
5. Характеристики — для заполнения карточки (материал, размер, цвет и т.д.)

ДАННЫЕ ТОВАРА:
${productInfo}

ПРАВИЛА:
- Пиши на русском языке, грамотно, без китайского маркетингового жаргона
- Название должно содержать категорию товара + ключевые свойства + для кого (если применимо)
- Описание: 1000-2000 символов, естественный текст с ключевыми фразами, не спам
- Буллеты: 5 штук, каждый 5-10 слов, начинается с эмодзи или ключевого слова
- Ключевые слова: реальные поисковые запросы покупателей на WB (не выдуманные)
- Характеристики: переведи с китайского, адаптируй размеры под РФ если возможно

Верни ТОЛЬКО JSON (без Markdown, без комментариев, без пояснений):
{
  "titleRu": "Название для карточки WB до 200 символов",
  "description": "SEO-описание 1000-2000 символов",
  "bullets": [
    "✅ Преимущество 1 — короткий тезис",
    "📦 Преимущество 2",
    "💪 Преимущество 3",
    "🔥 Преимущество 4",
    "⭐ Преимущество 5"
  ],
  "keywords": ["запрос 1", "запрос 2", "до 10 поисковых фраз"],
  "characteristics": {
    "Материал": "...",
    "Размер": "...",
    "Цвет": "...",
    "другие характеристики": "..."
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
      signal: AbortSignal.timeout(30_000),
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
    return AiResponseSchema.parse(parsed);
  } catch (e) {
    console.error(`[ai] ${model} failed:`, e instanceof Error ? e.message : e);
    return null;
  }
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
      return result;
    }
  }

  console.error('[ai] All models failed, using fallback');
  return buildFallback(req);
}

export const aiContentGenerator: AiContentGenerator = { generate };
