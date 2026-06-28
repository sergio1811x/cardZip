import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';

function escHtml(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function handleSearch1688(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  const match = (ctx as any).match as RegExpMatchArray | undefined;
  if (!match) return;

  const jobId = match[1] as string;

  try {
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

    const result = job.result_json as any;
    const raw = result.rawProduct ?? result.product;
    const titleCn = String(raw?.titleCn ?? '').trim();
    const seoContent = result.seoContent ?? result.product?.seoContent;

    if (!titleCn) {
      await ctx.answerCbQuery('Нет названия товара');
      return;
    }

    const searchUrl = `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(titleCn)}`;
    const keywords = (seoContent?.keywords ?? [])
      .slice(0, 3)
      .map((x: unknown) => escHtml(x))
      .join(', ');

    const text = [
      '🔎 <b>Поиск OEM-аналога на 1688</b>',
      '',
      `<b>Запрос (CN):</b> <code>${escHtml(titleCn.slice(0, 60))}</code>`,
      '',
      `<a href="${escHtml(searchUrl)}">🔗 Открыть поиск на 1688</a>`,
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
