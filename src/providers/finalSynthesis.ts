import type { ProductContext, AiContentResult } from '../types';

const SYNTHESIS_MODELS = [
  'deepseek/deepseek-v4-flash',
  'google/gemini-2.5-flash-lite-preview-09-2025',
];

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

export async function synthesizeReport(
  ctx: ProductContext,
  market: {
    confirmedCount: number;
    medianPrice: number | null;
    hasMarket: boolean;
    wb429: boolean;
  },
  economics: {
    costRub: number;
    roiPercent: number | null;
    weightMissing: boolean;
    platformMode: string;
  },
): Promise<AiContentResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return fallbackSeo(ctx);

  const prompt = `Ты — SEO-копирайтер и аналитик для Wildberries.

Тебе дан проанализированный товар с 1688:
- Тип: ${ctx.identity.productType}
- Короткое название: ${ctx.titles.shortRu}
- Категория: ${ctx.identity.categoryType}
- Сценарии: ${ctx.identity.useCases.join(', ')}
- Характеристики: ${JSON.stringify(ctx.facts)}
- Разрешённые claims: ${ctx.seoPolicy.allowedClaims.join(', ')}
- Запрещённые claims: ${ctx.seoPolicy.forbiddenClaims.join(', ')}
- Риски: ${ctx.riskTags.join(', ')}
- Качество данных: ${ctx.dataQuality.status} (${ctx.dataQuality.score}/10)

Рынок WB:
- Подтверждённые аналоги: ${market.confirmedCount}
- Медиана цены: ${market.medianPrice ? market.medianPrice + ' ₽' : 'не определена'}
- Рынок подтверждён: ${market.hasMarket ? 'да' : 'нет'}
${market.wb429 ? '- WB временно ограничил поиск\n' : ''}
Экономика:
- Себестоимость: ${economics.costRub} ₽
- ROI: ${economics.roiPercent ?? 'не рассчитан'}
- Вес: ${economics.weightMissing ? 'не указан' : 'есть'}
- Режим: ${economics.platformMode}

Сгенерируй SEO-карточку. Верни JSON:
{
  "titleRu": "SEO-название для WB, короткое и рыночное",
  "description": "описание 2-3 предложения, без неподтверждённых свойств",
  "bullets": ["5 буллетов-преимуществ"],
  "keywords": ["10-15 ключевых слов для WB"],
  "characteristics": {"Тип": "...", "Материал": "..."},
  "warnings": ["предупреждения если есть"]
}

Правила:
- Используй ТОЛЬКО allowedClaims.
- НЕ используй forbiddenClaims.
- НЕ пиши китайские слова.
- НЕ придумывай неподтверждённые свойства.
- Текст должен быть как карточка WB, не перевод 1688.`;

  for (const model of SYNTHESIS_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: 2000, temperature: 0.3,
          messages: [
            { role: 'system', content: 'SEO-копирайтер для WB. Верни СТРОГО JSON.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as any;
      const parsed = JSON.parse(cleanJson(data.choices?.[0]?.message?.content ?? ''));
      if (parsed?.titleRu) {
        console.log(`[synthesis] SEO: ${parsed.titleRu.slice(0, 40)}`);
        return {
          titleRu: parsed.titleRu,
          description: parsed.description ?? '',
          bullets: parsed.bullets ?? [],
          keywords: parsed.keywords ?? [],
          characteristics: parsed.characteristics ?? {},
          warnings: parsed.warnings ?? [],
        };
      }
    } catch { continue; }
  }

  return fallbackSeo(ctx);
}

function fallbackSeo(ctx: ProductContext): AiContentResult {
  return {
    titleRu: ctx.titles.wbTitleDraft || ctx.titles.shortRu || ctx.titles.cleanRu,
    description: '',
    bullets: [],
    keywords: [],
    characteristics: ctx.facts,
    isFallback: true,
  };
}
