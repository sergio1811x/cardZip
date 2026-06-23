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
    await ctx.answerCbQuery('Товар не найден');
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
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('No API key');

    const model = process.env.CONTENT_MODEL || 'deepseek/deepseek-v4-flash';
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 3000,
        temperature: 0.8,
        messages: [
          { role: 'system', content: 'Ты копирайтер для Wildberries. Пиши на русском.' },
          { role: 'user', content: `${prompt}\n\nИСХОДНЫЙ ТЕКСТ:\n${originalText}` },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await res.json() as any;
    const rewritten = data.choices?.[0]?.message?.content ?? '';

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
