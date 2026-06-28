import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';

function fP(n: number): string {
  return Math.round(Number(n) || 0).toLocaleString('ru-RU') + ' ₽';
}

function fN(n: number): string {
  return Math.round(Number(n) || 0).toLocaleString('ru-RU');
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function validWbUrl(url: unknown, id?: unknown): string {
  const raw = String(url ?? '');
  if (/^https:\/\/www\.wildberries\.ru\/catalog\/\d+\/detail\.aspx/i.test(raw)) return raw;
  const nmId = Number(id);
  return Number.isFinite(nmId) && nmId > 0 ? `https://www.wildberries.ru/catalog/${Math.round(nmId)}/detail.aspx` : 'https://www.wildberries.ru/';
}

export async function handleWbLeaders(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  const match = (ctx as any).match as RegExpMatchArray | undefined;
  if (!match) return;

  const jobId = match[1];

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

    const product = (job.result_json as any).product;
    const wbData = product?.wbData;
    const allCards = Array.isArray(wbData?.allCards) ? wbData.allCards : [];

    if (!allCards.length) {
      await ctx.answerCbQuery('Нет данных WB');
      return;
    }

    const leaders = [...allCards]
      .filter((c: any) => Number(c.feedbacks) > 0 && Number(c.price) > 0)
      .sort((a: any, b: any) => Number(b.feedbacks) - Number(a.feedbacks))
      .slice(0, 10);

    if (!leaders.length) {
      await ctx.answerCbQuery('Нет карточек с отзывами');
      return;
    }

    const lines = ['🏆 <b>ТОП-10 лидеров ниши WB</b>', ''];
    leaders.forEach((card: any, i: number) => {
      const titleRaw = String(card.title ?? card.name ?? '').trim();
      const title = titleRaw.length > 35 ? titleRaw.slice(0, 32) + '...' : titleRaw;
      const url = validWbUrl(card.url, card.id ?? card.nmId);
      lines.push(`${i + 1}. <a href="${esc(url)}">${fP(Number(card.price))}</a> ⭐${esc(card.rating || '—')} 💬${fN(Number(card.feedbacks))}`);
      lines.push(`   ${esc(title)}`);
    });

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    await ctx.answerCbQuery();
  } catch (e) {
    console.error('[leaders]', e);
    await ctx.answerCbQuery('Ошибка').catch(() => {});
  }
}
