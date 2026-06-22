import { z } from 'zod';
import type { AiContentGenerator, AiContentRequest, AiContentResult } from '../types';

const MODELS = [
  process.env.CONTENT_MODEL || 'deepseek/deepseek-v4-flash',
  process.env.FALLBACK_MODEL || 'deepseek/deepseek-v3.2',
  process.env.SECONDARY_FALLBACK_MODEL || 'qwen/qwen3.5-flash',
];

const AiResponseSchema = z.object({
  titleRu: z.string().min(10).max(200),
  description: z.string().min(100).max(3000),
  keywords: z.array(z.string()).min(1).max(10),
  characteristics: z.record(z.string()),
});

function buildFallback(req: AiContentRequest): AiContentResult {
  return {
    titleRu: req.titleCn,
    description: `Товар с 1688. Цена: ${req.priceYuan} юаней. MOQ: ${req.moq} шт. Вес: ${req.weightKg} кг.`,
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
  return `Ты эксперт по маркетплейсу Wildberries. Создай SEO-оптимизированный контент для карточки товара.

Данные товара с 1688.com:
- Название (кит.): ${req.titleCn}
- Цена закупки: ${req.priceYuan} юаней
- Минимальный заказ: ${req.moq} шт.
- Вес: ${req.weightKg} кг
- Поставщик: ${req.supplierName}${req.supplierRating ? ` (рейтинг: ${req.supplierRating})` : ''}

Верни ТОЛЬКО JSON (без Markdown, без пояснений):
{
  "titleRu": "Название для WB до 100 символов с ключевыми словами",
  "description": "SEO-описание 1000-2000 символов с ключевыми фразами для Wildberries",
  "keywords": ["фраза 1", "фраза 2", "до 10 поисковых запросов"],
  "characteristics": {
    "Материал": "...",
    "Размер": "...",
    "другие важные характеристики": "..."
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
