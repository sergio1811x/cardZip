import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';

const STYLE_PROMPTS: Record<string, string> = {
  short: 'Перепиши этот SEO-текст КОРОЧЕ: максимум 600 символов, только суть, без воды. Сохрани ключевые слова и структуру (название, описание, буллеты). Ответь ТОЛЬКО текстом, без JSON.',
  aggressive: 'Перепиши этот SEO-текст в стиле АГРЕССИВНЫХ ПРОДАЖ: создай ощущение срочности и дефицита, подчеркни выгоду, используй триггеры "последние штуки", "хит продаж", "не упусти". Сохрани ключевые слова. Ответь ТОЛЬКО текстом.',
  premium: 'Перепиши этот SEO-текст в ПРЕМИУМ стиле: элегантный, сдержанный тон, акцент на качестве материалов и эксклюзивности. Без восклицательных знаков. Сохрани ключевые слова. Ответь ТОЛЬКО текстом.',
};

export function buildRewriteKeyboard(jobId: string) {
  const { Markup } = require('telegraf');
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🔄 Короче', `rw_short_${jobId}`),
      Markup.button.callback('🔥 Агрессивно', `rw_aggressive_${jobId}`),
      Markup.button.callback('💎 Премиум', `rw_premium_${jobId}`),
    ],
  ]);
}

export async function handleRewrite(ctx: Context) {
  const match = (ctx as any).match as RegExpMatchArray | undefined;
  if (!match) return;

  const style = match[1] as string;
  const jobId = match[2] as string;
  const prompt = STYLE_PROMPTS[style];
  if (!prompt) return;

  const { data: job } = await supabase.from('jobs').select('result_json').eq('id', jobId).single();
  if (!job?.result_json) {
    await ctx.answerCbQuery('Данные недоступны');
    return;
  }

  const product = (job.result_json as any).product;
  const seo = product?.seoContent;
  if (!seo) {
    await ctx.answerCbQuery('SEO-текст не найден');
    return;
  }

  const originalText = [
    `НАЗВАНИЕ: ${seo.titleRu}`,
    `ОПИСАНИЕ: ${seo.description}`,
    `БУЛЛЕТЫ:\n${(seo.bullets || []).join('\n')}`,
    `КЛЮЧЕВЫЕ СЛОВА: ${(seo.keywords || []).join(', ')}`,
  ].join('\n\n');

  await ctx.answerCbQuery('Переписываю...');

  try {
    const REWRITE_MODELS = [
      { base: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-flash', key: 'OPENROUTER_API_KEY' },
      { base: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash-lite', key: 'OPENROUTER_API_KEY' },
      { base: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-4-scout', key: 'OPENROUTER_API_KEY' },
      { base: 'https://api.fireworks.ai/inference/v1', model: 'accounts/fireworks/models/deepseek-v4-flash', key: 'FIREWORKS_API_KEY' },
    ];

    let rewritten = '';
    for (const cfg of REWRITE_MODELS) {
      const apiKey = process.env[cfg.key];
      if (!apiKey) continue;
      try {
        const res = await fetch(`${cfg.base}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: cfg.model, max_tokens: 3000, temperature: 0.8,
            messages: [
              { role: 'system', content: 'Ты копирайтер для маркетплейс. Пиши на русском.' },
              { role: 'user', content: `${prompt}\n\nИСХОДНЫЙ ТЕКСТ:\n${originalText}` },
            ],
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) continue;
        const data = await res.json() as any;
        rewritten = data.choices?.[0]?.message?.content ?? '';
        if (rewritten) break;
      } catch { continue; }
    }

    if (!rewritten) {
      await ctx.reply('❌ Не удалось переписать текст.');
      return;
    }

    const styleLabel = { short: '🔄 Короткая версия', aggressive: '🔥 Агрессивные продажи', premium: '💎 Премиум стиль' }[style] ?? style;

    await ctx.editMessageText(
      `<b>${styleLabel}</b>\n\n${rewritten}`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('[rewrite]', e);
    await ctx.reply('❌ Ошибка при генерации. Попробуйте ещё раз.');
  }
}
