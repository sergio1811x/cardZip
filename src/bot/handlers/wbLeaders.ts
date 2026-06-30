import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';

function fP(n: number): string {
  return n.toLocaleString('ru-RU') + ' ₽';
}

function fN(n: number): string {
  return n.toLocaleString('ru-RU');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function handleWbLeaders(ctx: Context) {
  const match = (ctx as any).match as RegExpMatchArray | undefined;
  if (!match) return;

  const jobId = match[1];

  try {
    const { data: job } = await supabase.from('jobs').select('result_json').eq('id', jobId).single();
    if (!job?.result_json) {
      await ctx.answerCbQuery('Данные недоступны');
      return;
    }

    const product = (job.result_json as any).product;
    const wbData = product?.wbData;
    const allCards = wbData?.allCards ?? [];

    if (!allCards.length) {
      await ctx.answerCbQuery('Нет данных WB');
      return;
    }

    // Сортируем по отзывам (proxy для лидерства)
    const leaders = [...allCards]
      .filter((c: any) => c.feedbacks > 0)
      .sort((a: any, b: any) => b.feedbacks - a.feedbacks)
      .slice(0, 10);

    if (!leaders.length) {
      await ctx.answerCbQuery('Нет карточек с отзывами');
      return;
    }

    const lines = ['🏆 <b>ТОП-10 лидеров ниши WB</b>', ''];
    leaders.forEach((card: any, i: number) => {
      const title = card.title?.length > 35 ? card.title.slice(0, 32) + '...' : card.title ?? '';
      lines.push(`${i + 1}. <a href="${card.url}">${fP(card.price)}</a> ⭐${card.rating || '—'} 💬${fN(card.feedbacks)}`);
      lines.push(`   ${esc(title)}`);
    });

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    await ctx.answerCbQuery();
  } catch (e) {
    console.error('[leaders]', e);
    await ctx.answerCbQuery('Ошибка').catch(() => {});
  }
}
