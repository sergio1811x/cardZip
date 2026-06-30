import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';

export async function handleSearch1688(ctx: Context) {
  const match = (ctx as any).match as RegExpMatchArray | undefined;
  if (!match) return;

  const jobId = match[1] as string;

  try {
    const { data: job } = await supabase.from('jobs').select('result_json').eq('id', jobId).single();
    if (!job?.result_json) {
      await ctx.answerCbQuery('Данные недоступны');
      return;
    }

    const result = job.result_json as any;
    const raw = result.rawProduct ?? result.product;
    const titleCn = raw?.titleCn ?? '';
    const seoContent = result.seoContent ?? result.product?.seoContent;

    if (!titleCn) {
      await ctx.answerCbQuery('Нет названия товара');
      return;
    }

    // Формируем поисковый запрос для 1688
    const searchUrl = `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(titleCn)}`;

    const keywords = seoContent?.keywords?.slice(0, 3)?.join(', ') ?? '';

    const text = [
      '🔎 <b>Поиск OEM-аналога на 1688</b>',
      '',
      `<b>Запрос (CN):</b> <code>${titleCn.slice(0, 60)}</code>`,
      '',
      `<a href="${searchUrl}">🔗 Открыть поиск на 1688</a>`,
      '',
      keywords ? `<b>Ключевые слова для WB:</b> ${keywords}` : '',
      '',
      '<i>Скопируйте китайское название и вставьте в поиск 1688. Ищите фабрики (工厂) с рейтингом от 4.5.</i>',
    ].filter(Boolean).join('\n');

    await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    await ctx.answerCbQuery();
  } catch (e) {
    console.error('[search1688]', e);
    await ctx.answerCbQuery('Ошибка').catch(() => {});
  }
}
