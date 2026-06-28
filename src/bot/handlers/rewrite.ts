import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';

const STYLE_PROMPTS: Record<string, string> = {
  short: 'Перепиши этот SEO-текст короче: максимум 600 символов, только суть, без воды. Сохрани подтверждённые факты, ключевые слова и структуру (название, описание, буллеты). Не добавляй claims, которых нет в исходных данных. Ответь только текстом, без JSON.',
  aggressive: 'Перепиши этот SEO-текст в более продающем стиле, но без неподтверждённых claims вроде "хит продаж", "последние штуки", "лучший", "премиум", "безопасный", "сертифицированный", "водонепроницаемый". Сохрани ключевые слова и подтверждённые факты. Ответь только текстом.',
  premium: 'Перепиши этот SEO-текст в премиальном стиле: сдержанный тон, аккуратная подача, без восклицательных знаков. Не добавляй claims про качество, безопасность, сертификацию, водонепроницаемость или эксклюзивность, если их нет в исходном тексте. Сохрани ключевые слова. Ответь только текстом.',
};

const BANNED_REWRITE_CLAIMS = [
  /последн(?:ие|яя|ий)\s+штук[аи]?/gi,
  /хит\s+продаж/gi,
  /лучши[йея]/gi,
  /топ\s*продаж/gi,
  /сертифицированн\w*/gi,
  /водонепроницаем\w*/gi,
  /ip\s*\d{2}/gi,
  /безопасн\w*/gi,
  /лечебн\w*/gi,
];

function escHtml(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cleanRewriteText(text: string): string {
  let out = text
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/\b(undefined|null|NaN)\b/gi, '')
    .trim();
  for (const re of BANNED_REWRITE_CLAIMS) out = out.replace(re, '');
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildRewriteKeyboard(jobId: string) {
  const { Markup } = require('telegraf');
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🔄 Короче', `rw_short_${jobId}`),
      Markup.button.callback('🔥 Продающе', `rw_aggressive_${jobId}`),
      Markup.button.callback('💎 Премиум', `rw_premium_${jobId}`),
    ],
  ]);
}

export async function handleRewrite(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  const match = (ctx as any).match as RegExpMatchArray | undefined;
  if (!match) return;

  const style = match[1] as string;
  const jobId = match[2] as string;
  const prompt = STYLE_PROMPTS[style];
  if (!prompt) return;

  const { data: job } = await supabase
    .from('jobs')
    .select('result_json')
    .eq('id', jobId)
    .eq('user_id', userId)
    .single();

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
    `НАЗВАНИЕ: ${seo.titleRu ?? ''}`,
    `ОПИСАНИЕ: ${seo.description ?? ''}`,
    `БУЛЛЕТЫ:\n${(seo.bullets || []).join('\n')}`,
    `КЛЮЧЕВЫЕ СЛОВА: ${(seo.keywords || []).join(', ')}`,
  ].join('\n\n');

  await ctx.answerCbQuery('Переписываю...');

  try {
    const REWRITE_MODELS = [
      { base: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-flash', key: 'OPENROUTER_API_KEY' },
      { base: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash-lite-preview-09-2025', key: 'OPENROUTER_API_KEY' },
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
              { role: 'system', content: 'Ты копирайтер для Wildberries. Пиши на русском. Не добавляй неподтверждённые свойства товара.' },
              { role: 'user', content: `${prompt}\n\nИСХОДНЫЙ ТЕКСТ:\n${originalText}` },
            ],
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) continue;
        const data = await res.json() as any;
        rewritten = cleanRewriteText(data.choices?.[0]?.message?.content ?? '');
        if (rewritten) break;
      } catch { continue; }
    }

    if (!rewritten) {
      await ctx.reply('❌ Не удалось переписать текст.');
      return;
    }

    const styleLabel = { short: '🔄 Короткая версия', aggressive: '🔥 Продающая версия', premium: '💎 Премиум стиль' }[style] ?? style;

    await ctx.editMessageText(
      `<b>${escHtml(styleLabel)}</b>\n\n${escHtml(rewritten)}`,
      { parse_mode: 'HTML' }
    ).catch(() => ctx.reply(`<b>${escHtml(styleLabel)}</b>\n\n${escHtml(rewritten)}`, { parse_mode: 'HTML' }));
  } catch (e) {
    console.error('[rewrite]', e);
    await ctx.reply('❌ Ошибка при генерации. Попробуйте ещё раз.');
  }
}
