import { z } from 'zod';
import type { AiContentGenerator, AiContentRequest, AiContentResult } from '../types';

const MODELS = [
  process.env.CONTENT_MODEL || 'deepseek/deepseek-v4-flash',
  process.env.FALLBACK_MODEL || 'deepseek/deepseek-v3.2',
  process.env.SECONDARY_FALLBACK_MODEL || 'qwen/qwen3-235b-a22b-instruct-2507',
];

const AiResponseSchema = z.object({
  titleRu: z.string().min(10).max(200),
  description: z.string().min(100).max(3000),
  bullets: z.array(z.string()).min(3).max(5),
  keywords: z.array(z.string()).min(1).max(10),
  characteristics: z.record(z.string()),
});

function buildFallback(req: AiContentRequest): AiContentResult {
  return {
    titleRu: req.titleCn,
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
    productInfo += `\n\nОписание от поставщика (кит./англ.):\n${req.description.slice(0, 500)}`;
  }

  return `Ты эксперт по маркетплейсу Wildberries. Создай SEO-оптимизированный контент для карточки товара.

Данные товара:
${productInfo}

Используй характеристики от поставщика для заполнения полей. Переведи и адаптируй для российского рынка.

Верни ТОЛЬКО JSON (без Markdown, без пояснений):
{
  "titleRu": "Коммерческое название для WB до 200 символов с ключевыми словами",
  "description": "SEO-описание 1000-2000 символов для карточки Wildberries",
  "bullets": [
    "Ключевое преимущество 1 — короткий тезис для инфографики",
    "Ключевое преимущество 2",
    "Ключевое преимущество 3",
    "Ключевое преимущество 4",
    "Ключевое преимущество 5"
  ],
  "keywords": ["поисковая фраза 1", "фраза 2", "до 10 запросов"],
  "characteristics": {
    "Материал": "...",
    "Размер": "...",
    "Цвет": "...",
    "другие характеристики для карточки WB": "..."
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
        max_tokens: 2000,
        temperature: 0.7,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(25_000),
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
